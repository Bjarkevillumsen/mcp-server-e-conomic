import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EconomicClient } from '../src/economic/client.js';
import { STAGE1_ALLOWED_TOOLS } from '../src/stage1/allowlist.js';
import { createStage1Server } from '../src/stage1/server.js';

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.ECONOMIC_ENABLE_WRITES = 'true';
  process.env.ECONOMIC_ENABLE_BOOKING = 'false';
  process.env.ECONOMIC_EXPECTED_AGREEMENT_NUMBER = '1382005';
  process.env.ECONOMIC_DEFAULT_COMPANY_ID = 'squaremeter';
  process.env.ECONOMIC_DEFAULT_COMPANY_NAME = 'SquareMeter';
  delete process.env.ECONOMIC_POLICY_PATH;
  delete process.env.ECONOMIC_AUDIT_LOG;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('Stage 1 MCP profile', () => {
  it('advertises exactly the approved Stage 1 tools', async () => {
    await withStage1Client(async mcpClient => {
      const result = await mcpClient.listTools();
      expect(result.tools.map(tool => tool.name)).toEqual([...STAGE1_ALLOWED_TOOLS]);
      expect(result.tools.some(tool => /book|payment|delete|commit|economic_call_endpoint/.test(tool.name))).toBe(false);
      for (const tool of result.tools) {
        const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>;
        if (tool.name === 'stage1_list_companies') {
          expect(properties).not.toHaveProperty('companyId');
        } else {
          expect(properties).toHaveProperty('companyId');
          expect(tool.inputSchema.required).toContain('companyId');
        }
      }

      const genericRead = result.tools.find(tool => tool.name === 'stage1_read_economic');
      const properties = (genericRead?.inputSchema.properties ?? {}) as Record<string, unknown>;
      expect(properties).toHaveProperty('companyId');
      expect(properties).not.toHaveProperty('method');
      expect(properties).not.toHaveProperty('url');
      expect(properties).not.toHaveProperty('hostname');
    });
  });

  it('lists the authorized company without exposing either credential', async () => {
    await withStage1Client(async mcpClient => {
      const result = await mcpClient.callTool({ name: 'stage1_list_companies', arguments: {} });
      const text = JSON.stringify(resultJson(result));
      expect(resultJson(result)).toEqual({
        companies: [{
          companyId: 'squaremeter',
          displayName: 'SquareMeter',
          agreementNumber: '1382005',
          permissions: { read: true, draft: true },
        }],
      });
      expect(text).not.toContain('app');
      expect(text).not.toContain('grant');
    });
  });

  it('rejects an unknown company before any e-conomic request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await withStage1Client(async mcpClient => {
      const result = await mcpClient.callTool({
        name: 'stage1_check_connection',
        arguments: { companyId: 'unknown-company' },
      });
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    }, fetchMock as unknown as typeof fetch);
  });

  it('runs the authorization hook for every tool invocation', async () => {
    const authorize = vi.fn();
    await withStage1Client(async mcpClient => {
      const result = await mcpClient.callTool({
        name: 'stage1_check_connection',
        arguments: { companyId: 'squaremeter' },
      });
      expect(result.isError).not.toBe(true);
      expect(authorize).toHaveBeenCalledExactlyOnceWith('stage1_check_connection');
    }, async () => Response.json({ ok: true }), authorize);
  });

  it('performs bounded catalog reads and caps returned records', async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests.push(new Request(input, init));
      return Response.json({ collection: Array.from({ length: 550 }, (_, id) => ({ id })) });
    });

    await withStage1Client(async mcpClient => {
      const result = await mcpClient.callTool({
        name: 'stage1_read_economic',
        arguments: {
          companyId: 'squaremeter',
          serviceId: 'rest',
          pathTemplate: '/customers',
          pageSize: 200,
          maxRecords: 500,
          filter: 'name$like:*Test*',
        },
      });
      const parsed = resultJson(result) as {
        result: {
          data: { collection: unknown[] };
          page: { returnedRecords: number; truncated: boolean };
        };
      };

      expect(parsed.result.data.collection).toHaveLength(500);
      expect(parsed.result.page).toMatchObject({ returnedRecords: 500, truncated: true });
      expect(requests[0]?.method).toBe('GET');
      expect(requests[0]?.url).toContain('/customers?');
      expect(requests[0]?.url).toContain('pagesize=200');
      expect(requests[0]?.url).toContain('filter=');
    }, fetchMock as typeof fetch);
  });

  it('rejects arbitrary URLs before sending a request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await withStage1Client(async mcpClient => {
      const result = await mcpClient.callTool({
        name: 'stage1_read_economic',
        arguments: {
          companyId: 'squaremeter',
          serviceId: 'rest',
          pathTemplate: 'https://evil.example/customers',
        },
      });
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    }, fetchMock as unknown as typeof fetch);
  });

  it('creates one normalized invoice draft after validating agreement 1382005', async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith('/self')) {
        return Response.json({ agreementNumber: 1382005 });
      }
      return Response.json({
        draftInvoiceNumber: 12345,
        self: 'https://restapi.e-conomic.com/invoices/drafts/12345',
      }, { status: 201 });
    });

    await withStage1Client(async mcpClient => {
      const result = await mcpClient.callTool({
        name: 'stage1_create_sales_invoice_draft',
        arguments: {
          companyId: 'squaremeter',
          draft: validInvoiceDraft(),
          reference: 'MCP-STAGE1-TEST',
          reason: 'Controlled Stage 1 draft test',
          idempotencyKey: 'invoice-test-0001',
        },
      });

      expect(result.isError).not.toBe(true);
      expect(resultJson(result)).toEqual({
        success: true,
        company: { companyId: 'squaremeter', displayName: 'SquareMeter', agreementNumber: '1382005' },
        type: 'sales_invoice_draft',
        number: 12345,
        status: 'draft',
        reference: 'MCP-STAGE1-TEST',
      });
      expect(requests.map(request => request.method)).toEqual(['GET', 'POST']);
      expect(requests[1]?.url).toContain('/invoices/drafts');
      expect(requests.some(request => /book|send|payment/i.test(request.url))).toBe(false);
    }, fetchMock as typeof fetch);
  });

  it('creates one normalized unbooked journal draft entry', async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.url.endsWith('/self')) {
        return Response.json({ agreementNumber: 1382005 });
      }
      return Response.json({ entryNumber: 54321, voucherNumber: 77 }, { status: 201 });
    });

    await withStage1Client(async mcpClient => {
      const result = await mcpClient.callTool({
        name: 'stage1_create_journal_draft_entry',
        arguments: {
          companyId: 'squaremeter',
          entry: {
            entryTypeNumber: 1,
            journalNumber: 1,
            date: '2026-08-15T00:00:00Z',
            amount: 100,
            currency: 'DKK',
            text: 'MCP-STAGE1-TEST',
          },
          reference: 'MCP-STAGE1-TEST',
          reason: 'Controlled Stage 1 journal draft test',
          idempotencyKey: 'journal-test-0001',
        },
      });

      expect(result.isError).not.toBe(true);
      expect(resultJson(result)).toEqual({
        success: true,
        company: { companyId: 'squaremeter', displayName: 'SquareMeter', agreementNumber: '1382005' },
        type: 'journal_draft_entry',
        number: 54321,
        status: 'draft',
        reference: 'MCP-STAGE1-TEST',
      });
      expect(requests.map(request => request.method)).toEqual(['GET', 'POST']);
      expect(requests[1]?.url).toContain('/journalsapi/v15.0.0/draft-entries');
      expect(requests.some(request => /book|payment/i.test(request.url))).toBe(false);
    }, fetchMock as typeof fetch);
  });

  it('aborts a draft write when the connected agreement is not 1382005', async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({ agreementNumber: 9999999 });
    });

    await withStage1Client(async mcpClient => {
      const result = await mcpClient.callTool({
        name: 'stage1_create_sales_invoice_draft',
        arguments: {
          companyId: 'squaremeter',
          draft: validInvoiceDraft(),
          reason: 'Agreement mismatch regression test',
          idempotencyKey: 'invoice-test-0002',
        },
      });

      expect(result.isError).toBe(true);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe('GET');
      expect(requests[0]?.url).toMatch(/\/self$/);
    }, fetchMock as typeof fetch);
  });
});

async function withStage1Client(
  action: (client: Client) => Promise<void>,
  fetchImpl: typeof fetch = async () => Response.json({}),
  authorize?: (toolName: (typeof STAGE1_ALLOWED_TOOLS)[number]) => void | Promise<void>,
): Promise<void> {
  const economicClient = new EconomicClient({
    appSecretToken: 'app',
    agreementGrantToken: 'grant',
    fetchImpl,
  });
  const server = createStage1Server({ client: economicClient, authorize });
  const client = new Client({ name: 'stage1-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    await action(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function resultJson(result: unknown): unknown {
  const record = typeof result === 'object' && result !== null ? result as Record<string, unknown> : {};
  const content = Array.isArray(record.content) ? record.content : [];
  const block = content[0] as { type?: string; text?: string } | undefined;
  if (block?.type !== 'text' || typeof block.text !== 'string') {
    throw new Error('Expected a text MCP result.');
  }
  return JSON.parse(block.text) as unknown;
}

function validInvoiceDraft() {
  return {
    date: '2026-08-15',
    currency: 'DKK',
    customer: { customerNumber: 1001 },
    layout: { layoutNumber: 1 },
    paymentTerms: { paymentTermsNumber: 1 },
    recipient: { name: 'Stage 1 Test', vatZone: { vatZoneNumber: 1 } },
    lines: [
      {
        product: { productNumber: 'TEST' },
        quantity: 1,
        unitNetPrice: 100,
        description: 'MCP-STAGE1-TEST',
      },
    ],
  };
}
