import { createLocalJWKSet, importJWK, SignJWT, type JWTPayload } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AuthenticationError,
  AuthorizationError,
  ECONOMIC_DRAFT_CREATOR_ROLE,
  ECONOMIC_READER_ROLE,
  authorizeStage1Principal,
  createEntraTokenValidator,
  entraIssuer,
  type EntraConfig,
  type EntraPrincipal,
} from '../src/stage1/auth.js';
import { ENTRA_TEST_PRIVATE_JWK, ENTRA_TEST_PUBLIC_JWK } from './fixtures/entra-test-key.js';

const config: EntraConfig = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  apiClientId: '22222222-2222-4222-8222-222222222222',
  requiredScope: 'Mcp.Access',
};
const validator = createEntraTokenValidator(config, {
  keyResolver: createLocalJWKSet({ keys: [ENTRA_TEST_PUBLIC_JWK] }),
});
let privateKey: Awaited<ReturnType<typeof importJWK>>;

beforeAll(async () => {
  privateKey = await importJWK(ENTRA_TEST_PRIVATE_JWK, 'RS256');
});

describe('Entra token authentication', () => {
  it('returns 401 semantics for no token and malformed token', async () => {
    await expect(validator.validateAuthorizationHeader(undefined)).rejects.toBeInstanceOf(AuthenticationError);
    await expect(validator.validateAuthorizationHeader('Bearer not-a-jwt')).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('accepts a correctly signed, issued, scoped, and role-bearing token', async () => {
    const principal = await validator.validateToken(await signToken());
    expect(principal).toMatchObject({
      tenantId: config.tenantId,
      userOid: '33333333-3333-4333-8333-333333333333',
      username: 'reader@example.test',
      scopes: ['Mcp.Access'],
      roles: [ECONOMIC_READER_ROLE],
    });
  });

  it('fails closed when tenant OIDC discovery cannot be validated', async () => {
    const unavailable = createEntraTokenValidator(config, {
      fetchImpl: async () => new Response('unavailable', { status: 503 }),
    });
    await expect(unavailable.validateToken(await signToken())).rejects.toBeInstanceOf(AuthenticationError);

    const wrongIssuer = createEntraTokenValidator(config, {
      fetchImpl: async () => Response.json({
        issuer: 'https://login.microsoftonline.com/wrong/v2.0',
        jwks_uri: 'https://login.microsoftonline.com/common/discovery/v2.0/keys',
      }),
    });
    await expect(wrongIssuer.validateToken(await signToken())).rejects.toBeInstanceOf(AuthenticationError);
  });

  it.each([
    ['invalid signature', async () => corruptSignature(await signToken())],
    ['wrong issuer', async () => signToken({ issuer: 'https://login.microsoftonline.com/other/v2.0' })],
    ['wrong tenant', async () => signToken({ tenantId: '99999999-9999-4999-8999-999999999999' })],
    ['wrong audience', async () => signToken({ audience: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })],
    ['expired token', async () => signToken({ expiration: Math.floor(Date.now() / 1000) - 30 })],
    ['not-before in future', async () => signToken({ notBefore: Math.floor(Date.now() / 1000) + 60 })],
  ])('rejects %s with 401 semantics', async (_label, tokenFactory) => {
    await expect(validator.validateToken(await tokenFactory())).rejects.toBeInstanceOf(AuthenticationError);
  });
});

describe('Stage 1 Entra RBAC', () => {
  const basePrincipal: EntraPrincipal = {
    tenantId: config.tenantId,
    subject: 'subject',
    userOid: '33333333-3333-4333-8333-333333333333',
    scopes: ['Mcp.Access'],
    roles: [ECONOMIC_READER_ROLE],
  };

  it('returns 403 semantics when scope or application role is missing', () => {
    expect(() => authorizeStage1Principal({ ...basePrincipal, scopes: [] }, 'stage1_check_connection', config.requiredScope))
      .toThrow(AuthorizationError);
    expect(() => authorizeStage1Principal({ ...basePrincipal, roles: [] }, 'stage1_check_connection', config.requiredScope))
      .toThrow(AuthorizationError);
  });

  it('allows Reader reads and denies both draft writes', () => {
    expect(() => authorizeStage1Principal(basePrincipal, 'stage1_get_company_context', config.requiredScope)).not.toThrow();
    expect(() => authorizeStage1Principal(basePrincipal, 'stage1_create_sales_invoice_draft', config.requiredScope))
      .toThrow(AuthorizationError);
    expect(() => authorizeStage1Principal(basePrincipal, 'stage1_create_journal_draft_entry', config.requiredScope))
      .toThrow(AuthorizationError);
  });

  it('allows DraftCreator reads and exactly the two approved drafts', () => {
    const creator = { ...basePrincipal, roles: [ECONOMIC_DRAFT_CREATOR_ROLE] };
    expect(() => authorizeStage1Principal(creator, 'stage1_get_company_context', config.requiredScope)).not.toThrow();
    expect(() => authorizeStage1Principal(creator, 'stage1_create_sales_invoice_draft', config.requiredScope)).not.toThrow();
    expect(() => authorizeStage1Principal(creator, 'stage1_create_journal_draft_entry', config.requiredScope)).not.toThrow();
    expect(() => authorizeStage1Principal(creator, 'economic_call_endpoint', config.requiredScope)).toThrow(AuthorizationError);
  });
});

interface TokenOptions {
  issuer?: string;
  tenantId?: string;
  audience?: string;
  expiration?: number;
  notBefore?: number;
  scope?: string;
  roles?: string[];
}

async function signToken(options: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: JWTPayload = {
    tid: options.tenantId ?? config.tenantId,
    oid: '33333333-3333-4333-8333-333333333333',
    preferred_username: 'reader@example.test',
    scp: options.scope ?? config.requiredScope,
    roles: options.roles ?? [ECONOMIC_READER_ROLE],
    ver: '2.0',
  };

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: ENTRA_TEST_PUBLIC_JWK.kid })
    .setIssuer(options.issuer ?? entraIssuer(config.tenantId))
    .setAudience(options.audience ?? config.apiClientId)
    .setSubject('test-subject')
    .setIssuedAt(now)
    .setNotBefore(options.notBefore ?? now - 30)
    .setExpirationTime(options.expiration ?? now + 3_600)
    .sign(privateKey);
}

function corruptSignature(token: string): string {
  const parts = token.split('.');
  const signature = parts[2] ?? '';
  parts[2] = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
  return parts.join('.');
}
