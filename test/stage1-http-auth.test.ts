import type { AddressInfo } from 'node:net';
import { createLocalJWKSet, importJWK, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ECONOMIC_DRAFT_CREATOR_ROLE,
  ECONOMIC_READER_ROLE,
  createEntraTokenValidator,
  entraIssuer,
  type EntraConfig,
} from '../src/stage1/auth.js';
import { Stage1TechnicalLogger } from '../src/stage1/logging.js';
import type { Stage1StartupConfig } from '../src/stage1/startup.js';
import { createStage1HttpServer } from '../src/transports/stage1-http.js';
import { ENTRA_TEST_PRIVATE_JWK, ENTRA_TEST_PUBLIC_JWK } from './fixtures/entra-test-key.js';

const entra: EntraConfig = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  apiClientId: '22222222-2222-4222-8222-222222222222',
  requiredScope: 'Mcp.Access',
};
const config: Stage1StartupConfig = {
  production: true,
  host: '127.0.0.1',
  port: 3000,
  maxBodyBytes: 1_024,
  requestTimeoutMs: 5_000,
  rateLimitMaxRequests: 600,
  rateLimitWindowMs: 60_000,
  allowedOrigins: ['https://client.example.test'],
  publicBaseUrl: 'https://mcp.example.test',
  entra,
  companies: [{
    companyId: 'squaremeter',
    displayName: 'SquareMeter',
    agreementNumber: '1382005',
    enabled: true,
    access: { readUserOids: ['*'], draftUserOids: ['*'] },
    credentials: { appSecretToken: 'app', agreementGrantToken: 'grant' },
  }],
};

let baseUrl = '';
let privateKey: Awaited<ReturnType<typeof importJWK>>;
const tokenValidator = createEntraTokenValidator(entra, {
  keyResolver: createLocalJWKSet({ keys: [ENTRA_TEST_PUBLIC_JWK] }),
});
const server = createStage1HttpServer({
  config,
  tokenValidator,
  logger: new Stage1TechnicalLogger(() => undefined),
});

beforeAll(async () => {
  privateKey = await importJWK(ENTRA_TEST_PRIVATE_JWK, 'RS256');
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

describe('Stage 1 protected HTTP resource', () => {
  it('serves a minimal unauthenticated health response', async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers.get('strict-transport-security')).toBe('max-age=31536000');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
  });

  it('publishes tenant-specific OAuth protected-resource metadata', async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(response.status).toBe(200);
    const expectedMetadata = {
      resource: 'https://mcp.example.test/mcp',
      authorization_servers: [entraIssuer(entra.tenantId)],
      scopes_supported: ['https://mcp.example.test/mcp/Mcp.Access'],
      bearer_methods_supported: ['header'],
    };
    expect(await response.json()).toEqual(expectedMetadata);

    const pathSpecific = await fetch(
      `${baseUrl}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(pathSpecific.status).toBe(200);
    expect(await pathSpecific.json()).toEqual(expectedMetadata);
  });

  it('returns 401 for missing and invalid bearer tokens', async () => {
    const missing = await postMcp(mcpRequest('tools/list'));
    expect(missing.status).toBe(401);
    expect(missing.headers.get('www-authenticate')).toContain('oauth-protected-resource');
    expect(missing.headers.get('www-authenticate')).toContain(
      'scope="https://mcp.example.test/mcp/Mcp.Access"',
    );

    const invalid = await postMcp(mcpRequest('tools/list'), 'not-a-jwt');
    expect(invalid.status).toBe(401);
  });

  it('returns 403 for missing scope or missing application role', async () => {
    const missingScope = await postMcp(mcpRequest('tools/list'), await token({ scope: '' }));
    expect(missingScope.status).toBe(403);

    const missingRole = await postMcp(mcpRequest('tools/list'), await token({ roles: [] }));
    expect(missingRole.status).toBe(403);
  });

  it('returns HTTP 403 when Reader invokes either write tool', async () => {
    const readerToken = await token({ roles: [ECONOMIC_READER_ROLE] });
    for (const name of [
      'economic_create_sales_invoice_draft',
      'economic_create_journal_draft_entry',
    ]) {
      const response = await postMcp(mcpRequest('tools/call', { name, arguments: {} }), readerToken);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Forbidden' });
    }
  });

  it('rejects malformed MCP, wrong Content-Type, disallowed CORS, and oversized bodies', async () => {
    const readerToken = await token({ roles: [ECONOMIC_READER_ROLE] });

    const malformed = await postMcp({ nope: true }, readerToken);
    expect(malformed.status).toBe(400);

    const wrongType = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readerToken}`, 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(wrongType.status).toBe(415);

    const cors = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${readerToken}`,
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
      },
      body: JSON.stringify(mcpRequest('tools/list')),
    });
    expect(cors.status).toBe(403);

    const oversized = await postMcp({
      ...mcpRequest('tools/list'),
      padding: 'x'.repeat(2_000),
    }, readerToken);
    expect(oversized.status).toBe(413);
  });

  it('allows DraftCreator through the pre-dispatch authorization layer', async () => {
    const creator = await token({ roles: [ECONOMIC_DRAFT_CREATOR_ROLE] });
    const malformedWrite = await postMcp(
      mcpRequest('tools/call', {
        name: 'economic_create_sales_invoice_draft',
        arguments: {},
      }),
      creator,
    );
    // Authorization passed; MCP input validation reports the invalid payload as
    // an MCP response instead of an HTTP authorization failure.
    expect(malformedWrite.status).not.toBe(401);
    expect(malformedWrite.status).not.toBe(403);
  });

  it('returns a generic 500 response without stack traces or internal paths', async () => {
    const failingServer = createStage1HttpServer({
      config,
      tokenValidator: {
        async validateAuthorizationHeader() {
          throw new Error('failure at C:\\Sensitive\\internal-file.ts:42');
        },
        async validateToken() {
          throw new Error('failure at C:\\Sensitive\\internal-file.ts:42');
        },
      },
      logger: new Stage1TechnicalLogger(() => undefined),
    });
    await new Promise<void>((resolve, reject) => {
      failingServer.once('error', reject);
      failingServer.listen(0, '127.0.0.1', () => resolve());
    });
    try {
      const address = failingServer.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await token()}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(mcpRequest('tools/list')),
      });
      expect(response.status).toBe(500);
      const text = await response.text();
      expect(text).toBe('{"error":"Internal server error"}');
      expect(text).not.toContain('Sensitive');
      expect(text).not.toContain('stack');
    } finally {
      await new Promise<void>((resolve, reject) => failingServer.close(error => error ? reject(error) : resolve()));
    }
  });

  it('rate limits repeated MCP requests and returns Retry-After', async () => {
    const limitedServer = createStage1HttpServer({
      config: { ...config, rateLimitMaxRequests: 2, rateLimitWindowMs: 60_000 },
      tokenValidator,
      logger: new Stage1TechnicalLogger(() => undefined),
    });
    await new Promise<void>((resolve, reject) => {
      limitedServer.once('error', reject);
      limitedServer.listen(0, '127.0.0.1', () => resolve());
    });
    try {
      const address = limitedServer.address() as AddressInfo;
      const url = `http://127.0.0.1:${address.port}/mcp`;
      const request = () => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mcpRequest('tools/list')),
      });
      expect((await request()).status).toBe(401);
      expect((await request()).status).toBe(401);
      const blocked = await request();
      expect(blocked.status).toBe(429);
      expect(blocked.headers.get('retry-after')).toBe('60');
      expect(await blocked.json()).toEqual({ error: 'Too many requests' });
    } finally {
      await new Promise<void>((resolve, reject) => limitedServer.close(error => error ? reject(error) : resolve()));
    }
  });
});

function mcpRequest(method: string, params: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id: 1, method, params };
}

async function postMcp(body: unknown, accessToken?: string): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function token(options: { scope?: string; roles?: string[] } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  return new SignJWT({
    tid: entra.tenantId,
    oid: '33333333-3333-4333-8333-333333333333',
    preferred_username: 'reader@example.test',
    scp: options.scope ?? entra.requiredScope,
    roles: options.roles ?? [ECONOMIC_READER_ROLE],
    ver: '2.0',
  })
    .setProtectedHeader({ alg: 'RS256', kid: ENTRA_TEST_PUBLIC_JWK.kid })
    .setIssuer(entraIssuer(entra.tenantId))
    .setAudience(entra.apiClientId)
    .setSubject('test-subject')
    .setIssuedAt(now)
    .setNotBefore(now - 30)
    .setExpirationTime(now + 3_600)
    .sign(privateKey);
}
