import { existsSync } from 'node:fs';
import { readEntraConfig, type EntraConfig } from './auth.js';
import {
  legacyStage1Company,
  readStage1CompanyRegistry,
  type Stage1CompanyConfig,
} from './companies.js';

export interface Stage1StartupConfig {
  production: boolean;
  host: string;
  port: number;
  maxBodyBytes: number;
  requestTimeoutMs: number;
  allowedOrigins: string[];
  publicBaseUrl?: string;
  entra: EntraConfig;
  companies: readonly Stage1CompanyConfig[];
  companyRegistryPath?: string;
}

export function validateStage1Startup(
  environment: NodeJS.ProcessEnv = process.env,
  pathExists: (path: string) => boolean = existsSync,
  registryReader: (path: string) => Stage1CompanyConfig[] = readStage1CompanyRegistry,
): Stage1StartupConfig {
  const production = environment.NODE_ENV === 'production';
  const host = environment.MCP_HTTP_HOST?.trim() || '127.0.0.1';
  const port = boundedInteger(environment.PORT, 3000, 1, 65_535, 'PORT');
  const maxBodyBytes = boundedInteger(
    environment.MCP_MAX_BODY_BYTES,
    1_048_576,
    1_024,
    10_485_760,
    'MCP_MAX_BODY_BYTES',
  );
  const requestTimeoutMs = boundedInteger(
    environment.MCP_REQUEST_TIMEOUT_MS,
    30_000,
    1_000,
    120_000,
    'MCP_REQUEST_TIMEOUT_MS',
  );

  if (environment.ECONOMIC_ENABLE_BOOKING === 'true') {
    throw new Error('Stage 1 refuses to start while ECONOMIC_ENABLE_BOOKING=true.');
  }
  if (host !== '127.0.0.1' && !(environment.NODE_ENV !== 'production' && environment.MCP_ALLOW_NON_LOCALHOST_DEV === 'true')) {
    throw new Error('Stage 1 must bind MCP_HTTP_HOST to 127.0.0.1.');
  }
  if (production && environment.STAGE1_PROFILE !== 'true') {
    throw new Error('Production requires STAGE1_PROFILE=true.');
  }
  if (production && environment.ECONOMIC_ENABLE_BOOKING !== 'false') {
    throw new Error('Production requires ECONOMIC_ENABLE_BOOKING=false.');
  }
  if (production && environment.ECONOMIC_ENABLE_WRITES !== 'true') {
    throw new Error('Production Stage 1 requires ECONOMIC_ENABLE_WRITES=true for draft creation.');
  }
  if (production && environment.MCP_ALLOW_ANY_ORIGIN === 'true') {
    throw new Error('MCP_ALLOW_ANY_ORIGIN=true is forbidden in production.');
  }
  if (production && environment.MCP_HTTP_TOKEN) {
    throw new Error('MCP_HTTP_TOKEN is not a substitute for Entra authentication in Stage 1.');
  }

  const policyPath = environment.ECONOMIC_POLICY_PATH?.trim();
  if (production && (!policyPath || !pathExists(policyPath))) {
    throw new Error('Production requires an existing ECONOMIC_POLICY_PATH.');
  }
  if (production && !environment.ECONOMIC_AUDIT_LOG?.trim()) {
    throw new Error('Production requires ECONOMIC_AUDIT_LOG for the separate write audit trail.');
  }
  if (
    production &&
    environment.ECONOMIC_BASE_URL_REST &&
    trimSlash(environment.ECONOMIC_BASE_URL_REST) !== 'https://restapi.e-conomic.com'
  ) {
    throw new Error('Production forbids overriding the e-conomic REST hostname.');
  }
  if (
    production &&
    environment.ECONOMIC_BASE_URL_OPENAPI &&
    trimSlash(environment.ECONOMIC_BASE_URL_OPENAPI) !== 'https://apis.e-conomic.com'
  ) {
    throw new Error('Production forbids overriding the e-conomic OpenAPI hostname.');
  }

  const companyRegistryPath = environment.ECONOMIC_COMPANY_REGISTRY_PATH?.trim();
  let companies: readonly Stage1CompanyConfig[];
  if (companyRegistryPath) {
    if (!pathExists(companyRegistryPath)) {
      throw new Error('ECONOMIC_COMPANY_REGISTRY_PATH does not exist.');
    }
    companies = registryReader(companyRegistryPath);
  } else {
    companies = [legacyStage1Company(environment)];
  }

  const entra = readEntraConfig(environment);
  const allowedOrigins = (environment.MCP_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(assertHttpsOrigin);
  const publicBaseUrl = environment.MCP_PUBLIC_BASE_URL?.trim() || undefined;
  if (publicBaseUrl) {
    assertHttpsOrigin(publicBaseUrl);
  }

  return {
    production,
    host,
    port,
    maxBodyBytes,
    requestTimeoutMs,
    allowedOrigins,
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    entra,
    companies,
    ...(companyRegistryPath ? { companyRegistryPath } : {}),
  };
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer from ${min} through ${max}.`);
  }
  return parsed;
}

function assertHttpsOrigin(value: string): string {
  const parsed = new URL(value);
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('Configured public URLs and CORS origins must be clean HTTPS origins.');
  }
  return parsed.origin;
}

function trimSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}
