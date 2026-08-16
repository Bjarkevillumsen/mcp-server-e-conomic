import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose';
import {
  isStage1ReadTool,
  isStage1ToolName,
  isStage1WriteTool,
  type Stage1ToolName,
} from './allowlist.js';

export const ECONOMIC_READER_ROLE = 'Economic.Reader';
export const ECONOMIC_DRAFT_CREATOR_ROLE = 'Economic.DraftCreator';

export interface EntraConfig {
  tenantId: string;
  apiClientId: string;
  requiredScope: string;
}

export interface EntraPrincipal {
  tenantId: string;
  subject: string;
  userOid?: string;
  username?: string;
  roles: string[];
  scopes: string[];
}

export interface EntraTokenValidator {
  validateAuthorizationHeader(header: string | undefined): Promise<EntraPrincipal>;
  validateToken(token: string): Promise<EntraPrincipal>;
}

export interface EntraTokenValidatorOptions {
  keyResolver?: JWTVerifyGetKey;
  issuer?: string;
  fetchImpl?: typeof fetch;
}

export class AuthenticationError extends Error {
  readonly status = 401;

  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends Error {
  readonly status = 403;

  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'AuthorizationError';
  }
}

export function readEntraConfig(environment: NodeJS.ProcessEnv = process.env): EntraConfig {
  const tenantId = environment.ENTRA_TENANT_ID?.trim() ?? '';
  const apiClientId = environment.ENTRA_API_CLIENT_ID?.trim() ?? '';
  const requiredScope = environment.ENTRA_REQUIRED_SCOPE?.trim() ?? '';

  if (!isGuid(tenantId)) {
    throw new Error('ENTRA_TENANT_ID must be the single trusted tenant GUID.');
  }
  if (!isGuid(apiClientId)) {
    throw new Error('ENTRA_API_CLIENT_ID must be the API application client GUID.');
  }
  if (!requiredScope || /\s/.test(requiredScope)) {
    throw new Error('ENTRA_REQUIRED_SCOPE must be a single delegated scope value.');
  }

  return { tenantId, apiClientId, requiredScope };
}

export function entraIssuer(tenantId: string): string {
  return `https://login.microsoftonline.com/${tenantId}/v2.0`;
}

export function createEntraTokenValidator(
  config: EntraConfig,
  options: EntraTokenValidatorOptions = {},
): EntraTokenValidator {
  const expectedIssuer = options.issuer ?? entraIssuer(config.tenantId);
  let keyResolverPromise: Promise<JWTVerifyGetKey> | undefined;

  const getKeyResolver = (): Promise<JWTVerifyGetKey> => {
    if (options.keyResolver) {
      return Promise.resolve(options.keyResolver);
    }

    keyResolverPromise ??= loadRemoteKeyResolver(
      config,
      expectedIssuer,
      options.fetchImpl ?? fetch,
    ).catch(error => {
      keyResolverPromise = undefined;
      throw error;
    });
    return keyResolverPromise;
  };

  const validateToken = async (token: string): Promise<EntraPrincipal> => {
    if (!token || token.length > 32_768 || token.split('.').length !== 3) {
      throw new AuthenticationError();
    }

    try {
      const keyResolver = await getKeyResolver();
      const { payload } = await jwtVerify(token, keyResolver, {
        algorithms: ['RS256'],
        issuer: expectedIssuer,
        audience: config.apiClientId,
        requiredClaims: ['exp', 'tid', 'sub'],
        clockTolerance: 5,
      });

      if (payload.tid !== config.tenantId) {
        throw new AuthenticationError();
      }
      if (payload.ver !== undefined && payload.ver !== '2.0') {
        throw new AuthenticationError();
      }

      return principalFromPayload(payload);
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw error;
      }
      throw new AuthenticationError();
    }
  };

  return {
    async validateAuthorizationHeader(header: string | undefined): Promise<EntraPrincipal> {
      const match = /^Bearer ([^\s]+)$/.exec(header ?? '');
      if (!match?.[1]) {
        throw new AuthenticationError();
      }
      return validateToken(match[1]);
    },
    validateToken,
  };
}

export function authorizeStage1Principal(
  principal: EntraPrincipal,
  toolName?: string,
  requiredScope?: string,
): void {
  if (requiredScope && !principal.scopes.includes(requiredScope)) {
    throw new AuthorizationError('Required delegated scope is missing.');
  }

  const hasReader = principal.roles.includes(ECONOMIC_READER_ROLE);
  const hasDraftCreator = principal.roles.includes(ECONOMIC_DRAFT_CREATOR_ROLE);
  if (!hasReader && !hasDraftCreator) {
    throw new AuthorizationError('Required e-conomic application role is missing.');
  }

  if (toolName === undefined) {
    return;
  }
  if (!isStage1ToolName(toolName)) {
    throw new AuthorizationError('Tool is not allowed in the Stage 1 profile.');
  }
  if (isStage1ReadTool(toolName) && (hasReader || hasDraftCreator)) {
    return;
  }
  if (isStage1WriteTool(toolName) && hasDraftCreator) {
    return;
  }

  throw new AuthorizationError('The assigned role does not allow this Stage 1 tool.');
}

export function primaryEconomicRole(principal: EntraPrincipal): string | undefined {
  if (principal.roles.includes(ECONOMIC_DRAFT_CREATOR_ROLE)) {
    return ECONOMIC_DRAFT_CREATOR_ROLE;
  }
  if (principal.roles.includes(ECONOMIC_READER_ROLE)) {
    return ECONOMIC_READER_ROLE;
  }
  return undefined;
}

export function makeToolAuthorizer(
  principal: EntraPrincipal,
  requiredScope: string,
): (toolName: Stage1ToolName) => void {
  return toolName => authorizeStage1Principal(principal, toolName, requiredScope);
}

async function loadRemoteKeyResolver(
  config: EntraConfig,
  expectedIssuer: string,
  fetchImpl: typeof fetch,
): Promise<JWTVerifyGetKey> {
  const discoveryUrl = `${expectedIssuer}/.well-known/openid-configuration`;
  let response: Response;
  try {
    response = await fetchImpl(discoveryUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AuthenticationError();
  }

  if (!response.ok) {
    throw new AuthenticationError();
  }

  const metadata = await response.json() as Record<string, unknown>;
  if (metadata.issuer !== expectedIssuer || typeof metadata.jwks_uri !== 'string') {
    throw new AuthenticationError();
  }

  const jwksUrl = new URL(metadata.jwks_uri);
  if (
    jwksUrl.protocol !== 'https:' ||
    jwksUrl.hostname !== 'login.microsoftonline.com' ||
    jwksUrl.username ||
    jwksUrl.password ||
    jwksUrl.hash
  ) {
    throw new AuthenticationError();
  }

  // jose caches the remote JWKS and observes new key IDs after Microsoft's key
  // rotation cooldown. Discovery itself is retained for this validator instance.
  return createRemoteJWKSet(jwksUrl, {
    cacheMaxAge: 60 * 60 * 1_000,
    cooldownDuration: 30_000,
    timeoutDuration: 10_000,
  });
}

function principalFromPayload(payload: JWTPayload): EntraPrincipal {
  const roles = Array.isArray(payload.roles)
    ? payload.roles.filter((role): role is string => typeof role === 'string')
    : [];
  const scopes = typeof payload.scp === 'string'
    ? payload.scp.split(/\s+/).filter(Boolean)
    : [];
  const username = firstString(payload.preferred_username, payload.upn);

  return {
    tenantId: String(payload.tid),
    subject: String(payload.sub),
    ...(typeof payload.oid === 'string' ? { userOid: payload.oid } : {}),
    ...(username ? { username } : {}),
    roles,
    scopes,
  };
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function isGuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
