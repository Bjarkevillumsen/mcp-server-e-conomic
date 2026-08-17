import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { writeAuditEvent } from '../src/economic/audit.js';
import { redactSecrets } from '../src/errors.js';
import { ECONOMIC_DRAFT_CREATOR_ROLE } from '../src/stage1/auth.js';
import { Stage1TechnicalLogger } from '../src/stage1/logging.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('Stage 1 structured logging and audit', () => {
  it('writes only structured, redacted technical fields', () => {
    const lines: string[] = [];
    const logger = new Stage1TechnicalLogger(line => lines.push(line));
    logger.log({
      requestId: 'request-1',
      principal: {
        tenantId: 'tenant-1',
        subject: 'subject-1',
        userOid: 'oid-1',
        username: 'user@example.test',
        roles: [ECONOMIC_DRAFT_CREATOR_ROLE],
        scopes: ['Mcp.Access'],
      },
      tool: 'stage1_create_sales_invoice_draft',
      companyId: 'squaremeter',
      operationCategory: 'draft_write',
      policyResult: 'allowed',
      economicHttpStatus: 201,
      durationMs: 12.4,
      draftNumber: 12345,
      draftReference: 'MCP-STAGE1-TEST',
      error: 'Authorization: Bearer secret.jwt.value ECONOMIC_APP_SECRET_TOKEN=top-secret',
    });

    expect(lines).toHaveLength(1);
    const line = lines[0] ?? '';
    expect(line).not.toContain('secret.jwt.value');
    expect(line).not.toContain('top-secret');
    expect(JSON.parse(line)).toMatchObject({
      requestId: 'request-1',
      tenantId: 'tenant-1',
      userOid: 'oid-1',
      role: ECONOMIC_DRAFT_CREATOR_ROLE,
      tool: 'stage1_create_sales_invoice_draft',
      companyId: 'squaremeter',
      operationCategory: 'draft_write',
      economicHttpStatus: 201,
      draftNumber: 12345,
    });
  });

  it('redacts bearer and e-conomic credentials from arbitrary errors', () => {
    const value = redactSecrets(
      'Bearer abc.def.ghi X-AppSecretToken: app-secret ECONOMIC_AGREEMENT_GRANT_TOKEN=grant-secret',
    );
    expect(value).not.toContain('abc.def.ghi');
    expect(value).not.toContain('app-secret');
    expect(value).not.toContain('grant-secret');
  });

  it('writes a separate payload-free write audit record', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'economic-stage1-audit-'));
    const auditPath = join(directory, 'audit.jsonl');
    process.env.ECONOMIC_AUDIT_LOG = auditPath;
    try {
      await writeAuditEvent({
        requestId: 'request-2',
        tenantId: 'tenant-1',
        userOid: 'oid-1',
        role: ECONOMIC_DRAFT_CREATOR_ROLE,
        companyId: 'squaremeter',
        companyDisplayName: 'SquareMeter',
        tool: 'stage1_create_journal_draft_entry',
        action: 'create',
        allowed: true,
        policyResult: 'allowed',
        status: 'ok',
        result: 'success',
        agreementNumber: 1382005,
        draftNumber: 54321,
        draftReference: 'MCP-STAGE1-TEST',
        idempotencyKey: 'do-not-log-this-key',
      });

      const content = await readFile(auditPath, 'utf8');
      expect(content).not.toContain('do-not-log-this-key');
      expect(content).not.toContain('payload');
      const record = JSON.parse(content.trim()) as Record<string, unknown>;
      expect(record).toMatchObject({
        requestId: 'request-2',
        companyId: 'squaremeter',
        agreementNumber: 1382005,
        draftNumber: 54321,
        result: 'success',
      });
      expect(record).not.toHaveProperty('payload');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
