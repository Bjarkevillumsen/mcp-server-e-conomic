import { readFileSync, statSync } from 'node:fs';
import { EconomicClient, type EconomicClientOptions } from '../economic/client.js';
import {
  AuthorizationError,
  ECONOMIC_DRAFT_CREATOR_ROLE,
  ECONOMIC_READER_ROLE,
  type EntraPrincipal,
} from './auth.js';

export const STAGE1_MAX_COMPANIES = 100;
const MAX_REGISTRY_BYTES = 2 * 1024 * 1024;
const ALL_AUTHORIZED_USERS = '*';

export interface Stage1CompanyAccess {
  readUserOids: readonly string[];
  draftUserOids: readonly string[];
}

export interface Stage1CompanyCredentials {
  appSecretToken: string;
  agreementGrantToken: string;
}

export interface Stage1CompanyConfig {
  companyId: string;
  displayName: string;
  agreementNumber: string;
  enabled: boolean;
  access: Stage1CompanyAccess;
  credentials: Stage1CompanyCredentials;
}

export interface Stage1CompanySummary {
  companyId: string;
  displayName: string;
  agreementNumber: string;
  permissions: {
    read: boolean;
    draft: boolean;
  };
}

export interface ResolvedStage1Company extends Stage1CompanySummary {
  client: EconomicClient;
}

export type Stage1CompanyPermission = 'read' | 'draft';
export type Stage1CompanyClientFactory = (company: Stage1CompanyConfig) => EconomicClient;

export class Stage1CompanyRegistry {
  private readonly companies: ReadonlyMap<string, Stage1CompanyConfig>;
  private readonly clientFactory: Stage1CompanyClientFactory;

  constructor(
    companies: readonly Stage1CompanyConfig[],
    options: EconomicClientOptions & { clientFactory?: Stage1CompanyClientFactory } = {},
  ) {
    validateCompanies(companies);
    this.companies = new Map(companies.map(company => [company.companyId, freezeCompany(company)]));
    const { clientFactory, ...clientOptions } = options;
    this.clientFactory = clientFactory ?? (company => new EconomicClient({
      ...clientOptions,
      appSecretToken: company.credentials.appSecretToken,
      agreementGrantToken: company.credentials.agreementGrantToken,
    }));
  }

  listAuthorized(principal?: EntraPrincipal): Stage1CompanySummary[] {
    return [...this.companies.values()]
      .filter(company => company.enabled)
      .map(company => this.summary(company, principal))
      .filter(company => company.permissions.read || company.permissions.draft)
      .sort((left, right) => left.displayName.localeCompare(right.displayName, 'da'));
  }

  resolve(
    companyId: string,
    principal: EntraPrincipal | undefined,
    permission: Stage1CompanyPermission,
  ): ResolvedStage1Company {
    const normalizedId = normalizeCompanyId(companyId);
    const company = normalizedId ? this.companies.get(normalizedId) : undefined;
    if (!company?.enabled) {
      throw new AuthorizationError('Regnskabet findes ikke, er deaktiveret eller er ikke tilladt.');
    }

    const summary = this.summary(company, principal);
    if (!summary.permissions[permission]) {
      throw new AuthorizationError('Regnskabet findes ikke, er deaktiveret eller er ikke tilladt.');
    }

    return {
      ...summary,
      client: this.clientFactory(company),
    };
  }

  private summary(company: Stage1CompanyConfig, principal?: EntraPrincipal): Stage1CompanySummary {
    const globallyReadable = principal === undefined ||
      principal.roles.includes(ECONOMIC_READER_ROLE) ||
      principal.roles.includes(ECONOMIC_DRAFT_CREATOR_ROLE);
    const globallyDraftable = principal === undefined ||
      principal.roles.includes(ECONOMIC_DRAFT_CREATOR_ROLE);
    const draftAcl = matchesPrincipal(company.access.draftUserOids, principal);
    const readAcl = matchesPrincipal(company.access.readUserOids, principal) || draftAcl;

    return {
      companyId: company.companyId,
      displayName: company.displayName,
      agreementNumber: company.agreementNumber,
      permissions: {
        read: globallyReadable && readAcl,
        draft: globallyDraftable && draftAcl,
      },
    };
  }
}

export function readStage1CompanyRegistry(path: string): Stage1CompanyConfig[] {
  try {
    const stats = statSync(path);
    if (!stats.isFile() || stats.size < 2 || stats.size > MAX_REGISTRY_BYTES) {
      throw new Error('invalid registry file');
    }
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parseRegistry(parsed);
  } catch {
    throw new Error(`ECONOMIC_COMPANY_REGISTRY_PATH could not be read as a valid Stage 1 company registry: ${path}`);
  }
}

export function legacyStage1Company(environment: NodeJS.ProcessEnv = process.env): Stage1CompanyConfig {
  const companyId = normalizeCompanyId(environment.ECONOMIC_DEFAULT_COMPANY_ID ?? 'default');
  const displayName = environment.ECONOMIC_DEFAULT_COMPANY_NAME?.trim() || 'Default e-conomic company';
  const agreementNumber = normalizeAgreementNumber(environment.ECONOMIC_EXPECTED_AGREEMENT_NUMBER);
  const appSecretToken = normalizeSecret(environment.ECONOMIC_APP_SECRET_TOKEN);
  const agreementGrantToken = normalizeSecret(environment.ECONOMIC_AGREEMENT_GRANT_TOKEN);

  if (!companyId) throw new Error('ECONOMIC_DEFAULT_COMPANY_ID is invalid.');
  if (!isDisplayName(displayName)) throw new Error('ECONOMIC_DEFAULT_COMPANY_NAME is invalid.');
  if (!agreementNumber) throw new Error('ECONOMIC_EXPECTED_AGREEMENT_NUMBER must be configured as digits.');
  if (!appSecretToken) throw new Error('ECONOMIC_APP_SECRET_TOKEN is required.');
  if (!agreementGrantToken) throw new Error('ECONOMIC_AGREEMENT_GRANT_TOKEN is required.');

  return {
    companyId,
    displayName,
    agreementNumber,
    enabled: true,
    access: { readUserOids: [ALL_AUTHORIZED_USERS], draftUserOids: [ALL_AUTHORIZED_USERS] },
    credentials: { appSecretToken, agreementGrantToken },
  };
}

function parseRegistry(value: unknown): Stage1CompanyConfig[] {
  const root = requireRecord(value);
  assertExactKeys(root, ['version', 'companies']);
  if (root.version !== 1 || !Array.isArray(root.companies)) throw new Error('invalid registry');
  if (root.companies.length < 1 || root.companies.length > STAGE1_MAX_COMPANIES) {
    throw new Error('invalid company count');
  }

  const companies = root.companies.map(parseCompany);
  validateCompanies(companies);
  return companies;
}

function parseCompany(value: unknown): Stage1CompanyConfig {
  const company = requireRecord(value);
  assertExactKeys(company, [
    'companyId',
    'displayName',
    'agreementNumber',
    'enabled',
    'access',
    'credentials',
  ]);

  const companyId = normalizeCompanyId(company.companyId);
  const displayName = typeof company.displayName === 'string' ? company.displayName.trim() : '';
  const agreementNumber = normalizeAgreementNumber(company.agreementNumber);
  if (!companyId || !isDisplayName(displayName) || !agreementNumber || typeof company.enabled !== 'boolean') {
    throw new Error('invalid company identity');
  }

  const access = requireRecord(company.access);
  assertExactKeys(access, ['readUserOids', 'draftUserOids']);
  const readUserOids = parsePrincipalSelectors(access.readUserOids, false);
  const draftUserOids = parsePrincipalSelectors(access.draftUserOids, true);

  const credentials = requireRecord(company.credentials);
  assertExactKeys(credentials, ['appSecretToken', 'agreementGrantToken']);
  const appSecretToken = normalizeSecret(credentials.appSecretToken);
  const agreementGrantToken = normalizeSecret(credentials.agreementGrantToken);
  if (!appSecretToken || !agreementGrantToken) throw new Error('invalid credentials');

  return {
    companyId,
    displayName,
    agreementNumber,
    enabled: company.enabled,
    access: { readUserOids, draftUserOids },
    credentials: { appSecretToken, agreementGrantToken },
  };
}

function validateCompanies(companies: readonly Stage1CompanyConfig[]): void {
  if (companies.length < 1 || companies.length > STAGE1_MAX_COMPANIES) {
    throw new Error(`Stage 1 requires between 1 and ${STAGE1_MAX_COMPANIES} companies.`);
  }
  const ids = new Set<string>();
  const agreements = new Set<string>();
  let enabledCount = 0;
  for (const company of companies) {
    if (!normalizeCompanyId(company.companyId) || company.companyId !== normalizeCompanyId(company.companyId)) {
      throw new Error('Every Stage 1 company must have a canonical companyId.');
    }
    if (
      !isDisplayName(company.displayName) ||
      company.displayName !== company.displayName.trim() ||
      normalizeAgreementNumber(company.agreementNumber) !== company.agreementNumber ||
      typeof company.enabled !== 'boolean' ||
      normalizeSecret(company.credentials?.appSecretToken) !== company.credentials?.appSecretToken ||
      normalizeSecret(company.credentials?.agreementGrantToken) !== company.credentials?.agreementGrantToken
    ) {
      throw new Error('Every Stage 1 company must have valid metadata and credentials.');
    }
    parsePrincipalSelectors(company.access?.readUserOids, false);
    parsePrincipalSelectors(company.access?.draftUserOids, true);
    if (ids.has(company.companyId) || agreements.has(company.agreementNumber)) {
      throw new Error('Stage 1 company IDs and agreement numbers must be unique.');
    }
    ids.add(company.companyId);
    agreements.add(company.agreementNumber);
    if (company.enabled) enabledCount += 1;
  }
  if (enabledCount === 0) throw new Error('At least one Stage 1 company must be enabled.');
}

function parsePrincipalSelectors(value: unknown, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 500) {
    throw new Error('invalid company access list');
  }
  const result = value.map(selector => {
    if (selector === ALL_AUTHORIZED_USERS) return selector;
    if (typeof selector !== 'string' || !isGuid(selector)) throw new Error('invalid user OID');
    return selector.toLowerCase();
  });
  if (new Set(result).size !== result.length) throw new Error('duplicate user OID');
  if (result.includes(ALL_AUTHORIZED_USERS) && result.length !== 1) {
    throw new Error('wildcard must be the only company access selector');
  }
  return result;
}

function matchesPrincipal(selectors: readonly string[], principal?: EntraPrincipal): boolean {
  if (selectors.includes(ALL_AUTHORIZED_USERS)) return true;
  const userOid = principal?.userOid?.toLowerCase();
  return Boolean(userOid && selectors.includes(userOid));
}

function freezeCompany(company: Stage1CompanyConfig): Stage1CompanyConfig {
  return Object.freeze({
    ...company,
    access: Object.freeze({
      readUserOids: Object.freeze(parsePrincipalSelectors(company.access.readUserOids, false)),
      draftUserOids: Object.freeze(parsePrincipalSelectors(company.access.draftUserOids, true)),
    }),
    credentials: Object.freeze({ ...company.credentials }),
  });
}

function normalizeCompanyId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(normalized) ? normalized : undefined;
}

function normalizeAgreementNumber(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return undefined;
  const normalized = value.trim().replace(/^0+(?=\d)/, '');
  return normalized === '0' ? undefined : normalized;
}

function normalizeSecret(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized.length >= 1 && normalized.length <= 8_192 ? normalized : undefined;
}

function isDisplayName(value: string): boolean {
  return value.length >= 1 && value.length <= 120 && !/[\r\n\0]/.test(value);
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected object');
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some(key => !allowedSet.has(key)) || allowed.some(key => !(key in value))) {
    throw new Error('unexpected or missing registry field');
  }
}

function isGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
