import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ECONOMIC_DRAFT_CREATOR_ROLE, ECONOMIC_READER_ROLE, type EntraPrincipal } from '../src/stage1/auth.js';
import {
  STAGE1_MAX_COMPANIES,
  Stage1CompanyRegistry,
  readStage1CompanyRegistry,
  type Stage1CompanyConfig,
} from '../src/stage1/companies.js';

const temporaryDirectories: string[] = [];
const readerOid = '33333333-3333-4333-8333-333333333333';
const otherOid = '44444444-4444-4444-8444-444444444444';

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('Stage 1 multi-company registry', () => {
  it(`accepts ${STAGE1_MAX_COMPANIES} isolated companies and rejects company 101`, async () => {
    const companies = Array.from({ length: STAGE1_MAX_COMPANIES }, (_, index) => company(index + 1));
    const validPath = await registryFile(companies);
    expect(readStage1CompanyRegistry(validPath)).toHaveLength(STAGE1_MAX_COMPANIES);

    const invalidPath = await registryFile([...companies, company(STAGE1_MAX_COMPANIES + 1)]);
    expect(() => readStage1CompanyRegistry(invalidPath)).toThrow(/valid Stage 1 company registry/i);
  });

  it('rejects duplicate company IDs, duplicate agreements, unknown fields, and missing secrets', async () => {
    const duplicateId = [company(1), { ...company(2), companyId: 'company-1' }];
    const duplicateAgreement = [company(1), { ...company(2), agreementNumber: '100001' }];
    const unknownField = [{ ...company(1), unexpected: true }];
    const missingSecret = [{
      ...company(1),
      credentials: { ...company(1).credentials, agreementGrantToken: '' },
    }];

    for (const companies of [duplicateId, duplicateAgreement, unknownField, missingSecret]) {
      const path = await registryFile(companies);
      expect(() => readStage1CompanyRegistry(path)).toThrow(/valid Stage 1 company registry/i);
    }
  });

  it('never exposes credentials while listing authorized companies', () => {
    const registry = new Stage1CompanyRegistry([
      company(1, { readUserOids: [readerOid], draftUserOids: [] }),
      company(2, { readUserOids: [otherOid], draftUserOids: [] }),
    ]);
    const list = registry.listAuthorized(principal([ECONOMIC_READER_ROLE]));

    expect(list).toEqual([{
      companyId: 'company-1',
      displayName: 'Company 1',
      agreementNumber: '100001',
      permissions: { read: true, draft: false },
    }]);
    expect(JSON.stringify(list)).not.toContain('app-secret');
    expect(JSON.stringify(list)).not.toContain('grant-token');
  });

  it('round-trips Danish company names as UTF-8 without mojibake', async () => {
    const companies = [
      { ...company(1), displayName: 'Ejendommen Sølvgade 96 ApS' },
      { ...company(2), displayName: 'Værnedamsvej - Den Franske Skole' },
      { ...company(3), displayName: 'Sølvgade Holding ApS' },
    ];
    const path = await registryFile(companies);
    const registry = new Stage1CompanyRegistry(readStage1CompanyRegistry(path));
    const names = registry.listAuthorized(principal([ECONOMIC_READER_ROLE])).map(item => item.displayName);

    expect(names).toContain('Ejendommen Sølvgade 96 ApS');
    expect(names).toContain('Værnedamsvej - Den Franske Skole');
    expect(names).toContain('Sølvgade Holding ApS');
    expect(JSON.stringify(names)).not.toMatch(/Ã|Â/);
  });

  it('enforces company-specific read and draft access in addition to global Entra roles', () => {
    const registry = new Stage1CompanyRegistry([
      company(1, { readUserOids: [readerOid], draftUserOids: [otherOid] }),
    ]);

    expect(() => registry.resolve('company-1', principal([ECONOMIC_READER_ROLE]), 'read')).not.toThrow();
    expect(() => registry.resolve('company-1', principal([ECONOMIC_READER_ROLE]), 'draft')).toThrow(/not allowed|ikke tilladt/i);
    expect(() => registry.resolve('company-1', principal([ECONOMIC_DRAFT_CREATOR_ROLE]), 'draft')).toThrow(/not allowed|ikke tilladt/i);
    expect(() => registry.resolve('missing', principal([ECONOMIC_READER_ROLE]), 'read')).toThrow(/not allowed|ikke tilladt/i);
  });

  it('uses only the selected company credential pair for each e-conomic request', async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests.push(new Request(input, init));
      return Response.json({ ok: true });
    });
    const registry = new Stage1CompanyRegistry([company(1), company(2)], { fetchImpl: fetchMock });
    const reader = principal([ECONOMIC_READER_ROLE]);

    await registry.resolve('company-1', reader, 'read').client.rest('/');
    await registry.resolve('company-2', reader, 'read').client.rest('/');

    expect(requests).toHaveLength(2);
    expect(requests[0]?.headers.get('X-AppSecretToken')).toBe('app-secret-1');
    expect(requests[0]?.headers.get('X-AgreementGrantToken')).toBe('grant-token-1');
    expect(requests[1]?.headers.get('X-AppSecretToken')).toBe('app-secret-2');
    expect(requests[1]?.headers.get('X-AgreementGrantToken')).toBe('grant-token-2');
  });
});

function company(
  number: number,
  access: Stage1CompanyConfig['access'] = { readUserOids: ['*'], draftUserOids: ['*'] },
): Stage1CompanyConfig {
  return {
    companyId: `company-${number}`,
    displayName: `Company ${number}`,
    agreementNumber: String(100_000 + number),
    enabled: true,
    access,
    credentials: {
      appSecretToken: `app-secret-${number}`,
      agreementGrantToken: `grant-token-${number}`,
    },
  };
}

function principal(roles: string[]): EntraPrincipal {
  return {
    tenantId: '11111111-1111-4111-8111-111111111111',
    subject: 'test-subject',
    userOid: readerOid,
    username: 'reader@example.test',
    roles,
    scopes: ['Mcp.Access'],
  };
}

async function registryFile(companies: unknown[]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'economic-mcp-companies-'));
  temporaryDirectories.push(directory);
  const path = join(directory, 'companies.stage1.json');
  await writeFile(path, JSON.stringify({ version: 1, companies }), 'utf8');
  return path;
}
