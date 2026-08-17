import { describe, expect, it } from 'vitest';
import { validateStage1Startup } from '../src/stage1/startup.js';

describe('Stage 1 production startup validation', () => {
  it('accepts a complete fail-closed production configuration', () => {
    expect(validateStage1Startup(validEnvironment(), path => path === 'C:\\policy.json')).toMatchObject({
      production: true,
      host: '127.0.0.1',
      companies: [{ agreementNumber: '1382005' }],
      entra: { requiredScope: 'Mcp.Access' },
    });
  });

  it.each([
    ['Stage 1 profile', (env: NodeJS.ProcessEnv) => delete env.STAGE1_PROFILE],
    ['booking false', (env: NodeJS.ProcessEnv) => { env.ECONOMIC_ENABLE_BOOKING = 'true'; }],
    ['policy file', (env: NodeJS.ProcessEnv) => delete env.ECONOMIC_POLICY_PATH],
    ['tenant', (env: NodeJS.ProcessEnv) => delete env.ENTRA_TENANT_ID],
    ['audience', (env: NodeJS.ProcessEnv) => delete env.ENTRA_API_CLIENT_ID],
    ['app secret', (env: NodeJS.ProcessEnv) => delete env.ECONOMIC_APP_SECRET_TOKEN],
    ['agreement grant', (env: NodeJS.ProcessEnv) => delete env.ECONOMIC_AGREEMENT_GRANT_TOKEN],
    ['audit path', (env: NodeJS.ProcessEnv) => delete env.ECONOMIC_AUDIT_LOG],
    ['expected agreement', (env: NodeJS.ProcessEnv) => delete env.ECONOMIC_EXPECTED_AGREEMENT_NUMBER],
    ['localhost bind', (env: NodeJS.ProcessEnv) => { env.MCP_HTTP_HOST = '0.0.0.0'; }],
    ['CORS wildcard', (env: NodeJS.ProcessEnv) => { env.MCP_ALLOW_ANY_ORIGIN = 'true'; }],
    ['REST credential destination', (env: NodeJS.ProcessEnv) => { env.ECONOMIC_BASE_URL_REST = 'https://evil.example'; }],
    ['OpenAPI credential destination', (env: NodeJS.ProcessEnv) => { env.ECONOMIC_BASE_URL_OPENAPI = 'https://evil.example'; }],
  ])('fails closed when %s is unsafe or missing', (_label, mutate) => {
    const env = validEnvironment();
    mutate(env);
    expect(() => validateStage1Startup(env, () => true)).toThrow();
  });

  it('fails when the configured policy path does not exist', () => {
    expect(() => validateStage1Startup(validEnvironment(), () => false)).toThrow(/policy/i);
  });

  it('loads a multi-company registry without legacy single-company credentials', () => {
    const env = validEnvironment();
    delete env.ECONOMIC_APP_SECRET_TOKEN;
    delete env.ECONOMIC_AGREEMENT_GRANT_TOKEN;
    delete env.ECONOMIC_EXPECTED_AGREEMENT_NUMBER;
    env.ECONOMIC_COMPANY_REGISTRY_PATH = 'C:\\companies.stage1.json';
    const companies = [{
      companyId: 'squaremeter',
      displayName: 'SquareMeter',
      agreementNumber: '1382005',
      enabled: true,
      access: { readUserOids: ['*'], draftUserOids: [] },
      credentials: { appSecretToken: 'app', agreementGrantToken: 'grant' },
    }];

    const result = validateStage1Startup(env, () => true, () => companies);
    expect(result.companyRegistryPath).toBe('C:\\companies.stage1.json');
    expect(result.companies).toEqual(companies);
  });
});

function validEnvironment(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    STAGE1_PROFILE: 'true',
    MCP_HTTP_HOST: '127.0.0.1',
    PORT: '3000',
    ENTRA_TENANT_ID: '11111111-1111-4111-8111-111111111111',
    ENTRA_API_CLIENT_ID: '22222222-2222-4222-8222-222222222222',
    ENTRA_REQUIRED_SCOPE: 'Mcp.Access',
    ECONOMIC_ENABLE_WRITES: 'true',
    ECONOMIC_ENABLE_BOOKING: 'false',
    ECONOMIC_EXPECTED_AGREEMENT_NUMBER: '1382005',
    ECONOMIC_POLICY_PATH: 'C:\\policy.json',
    ECONOMIC_APP_SECRET_TOKEN: 'app-secret',
    ECONOMIC_AGREEMENT_GRANT_TOKEN: 'grant-token',
    ECONOMIC_AUDIT_LOG: 'C:\\audit.jsonl',
    MCP_ALLOWED_ORIGINS: 'https://client.example.test',
    MCP_PUBLIC_BASE_URL: 'https://mcp.example.test',
  };
}
