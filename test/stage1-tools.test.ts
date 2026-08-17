import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EconomicClient } from '../src/economic/client.js';
import { STAGE1_ALLOWED_TOOLS } from '../src/stage1/allowlist.js';
import type { Stage1CompanyConfig } from '../src/stage1/companies.js';
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
        if (tool.name === 'economic_list_companies' || tool.name === 'economic_describe_data') {
          expect(properties).not.toHaveProperty('companyId');
        } else if (tool.name === 'economic_supplier_transactions') {
          expect(properties).toHaveProperty('companyIds');
          expect(properties).not.toHaveProperty('companyId');
        } else {
          expect(properties).toHaveProperty('companyId');
          expect(tool.inputSchema.required).toContain('companyId');
        }
      }

      expect(result.tools.every(tool => !tool.name.startsWith('stage1_'))).toBe(true);
      const genericRead = result.tools.find(tool => tool.name === 'economic_query');
      const properties = (genericRead?.inputSchema.properties ?? {}) as Record<string, unknown>;
      expect(properties).toHaveProperty('companyId');
      expect(properties).toHaveProperty('dataset');
      expect(properties).toHaveProperty('filters');
      expect(properties).not.toHaveProperty('resource');
      expect(properties).not.toHaveProperty('filter');
      expect((properties.pageSize as { maximum?: number }).maximum).toBe(100);
    });
  });

  it('lists the authorized company without exposing either credential', async () => {
    await withStage1Client(async mcpClient => {
      const result = await mcpClient.callTool({ name: 'economic_list_companies', arguments: {} });
      const text = JSON.stringify(resultJson(result));
      expect(resultJson(result)).toEqual({
        count: 1,
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

  it('documents dataset fields, operators, examples, and the compiled filter DSL', async () => {
    await withStage1Client(async mcpClient => {
      const result = await mcpClient.callTool({
        name: 'economic_describe_data',
        arguments: { dataset: 'booked_entries' },
      });
      const parsed = resultJson(result) as {
        dataset: { upstream: unknown; filterFields: Record<string, unknown>; examples: unknown[] };
        filterSyntax: { underlyingDsl: { mapping: string }; operators: Record<string, string> };
        paging: { pageSizeMax: number };
      };
      expect(parsed.dataset.filterFields).toHaveProperty('supplierNumber');
      expect(parsed.dataset.upstream).toEqual({ serviceId: 'booked-entries', resource: 'booked-entries' });
      expect(parsed.dataset.examples.length).toBeGreaterThan(0);
      expect(parsed.filterSyntax.underlyingDsl.mapping).toContain('eq->$eq:');
      expect(parsed.filterSyntax.operators.like).toMatch(/case-insensitive/i);
      expect(parsed.paging.pageSizeMax).toBe(100);
    });
  });

  it('rejects an unknown company before any e-conomic request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await withStage1Client(async mcpClient => {
      const result = await mcpClient.callTool({
        name: 'economic_get_company_context',
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
        name: 'economic_get_company_context',
        arguments: { companyId: 'squaremeter' },
      });
      expect(result.isError).not.toBe(true);
      expect(authorize).toHaveBeenCalledExactlyOnceWith('economic_get_company_context');
    }, async () => Response.json({ ok: true }), authorize);
  });

  it('performs bounded catalog reads and caps returned records', async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      requests.push(new Request(input, init));
      const request = requests.at(-1) as Request;
      const page = Number(new URL(request.url).searchParams.get('skipPages'));
      return Response.json({
        items: Array.from({ length: 100 }, (_, id) => ({
          id: page * 100 + id,
          self: `https://example.test/customers/${id}`,
          objectVersion: 'noise',
        })),
        pagination: { nextPage: 'technical-noise' },
      });
    });

    await withStage1Client(async mcpClient => {
      const result = await mcpClient.callTool({
        name: 'economic_query',
        arguments: {
          companyId: 'squaremeter',
          dataset: 'customers',
          pageSize: 100,
          maxRecords: 500,
          filters: [{ field: 'name', operator: 'like', value: 'Test' }],
        },
      });
      const parsed = resultJson(result) as {
        records: Array<Record<string, unknown>>;
        page: { returnedRecords: number; pagesFetched: number; truncated: boolean };
      };

      expect(parsed.records).toHaveLength(500);
      expect(parsed.records[0]).not.toHaveProperty('self');
      expect(parsed.records[0]).not.toHaveProperty('objectVersion');
      expect(parsed.page).toMatchObject({ returnedRecords: 500, pagesFetched: 5, truncated: true });
      expect(requests).toHaveLength(5);
      expect(requests[0]?.method).toBe('GET');
      expect(requests[0]?.url).toContain('/customersapi/v3.1.0/Customers/paged?');
      expect(requests[0]?.url).toContain('pageSize=100');
      expect(requests[0]?.url).toContain('skipPages=0');
      expect(requests[4]?.url).toContain('skipPages=4');
      expect(requests[0]?.url).toContain('filter=');
    }, fetchMock as typeof fetch);
  });

  it('auto-pages until a short upstream page and then reports a complete result', async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      requests.push(request);
      const page = Number(new URL(request.url).searchParams.get('skipPages'));
      const count = page === 0 ? 100 : 25;
      return Response.json({ items: Array.from({ length: count }, (_, id) => ({ id: page * 100 + id })) });
    });

    await withStage1Client(async mcpClient => {
      const result = await mcpClient.callTool({
        name: 'economic_query',
        arguments: { companyId: 'squaremeter', dataset: 'customers', pageSize: 100, maxRecords: 500 },
      });
      const parsed = resultJson(result) as {
        records: unknown[];
        page: { returnedRecords: number; pagesFetched: number; truncated: boolean; nextPage?: number };
      };
      expect(parsed.records).toHaveLength(125);
      expect(parsed.page).toEqual(expect.objectContaining({
        returnedRecords: 125,
        pagesFetched: 2,
        truncated: false,
      }));
      expect(parsed.page).not.toHaveProperty('nextPage');
      expect(requests).toHaveLength(2);
    }, fetchMock as typeof fetch);
  });

  it('rejects an invalid dataset filter field before sending a request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await withStage1Client(async mcpClient => {
      const result = await mcpClient.callTool({
        name: 'economic_query',
        arguments: {
          companyId: 'squaremeter',
          dataset: 'booked_entries',
          filters: [{ field: 'madeUpField', operator: 'eq', value: 1 }],
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(/does not expose filter field|valid fields/i);
      expect(fetchMock).not.toHaveBeenCalled();
    }, fetchMock as unknown as typeof fetch);
  });

  it('distinguishes a valid empty filter result from an invalid filter', async () => {
    const fetchMock = vi.fn(async () => Response.json({ items: [] }));
    await withStage1Client(async mcpClient => {
      const result = await mcpClient.callTool({
        name: 'economic_query',
        arguments: {
          companyId: 'squaremeter',
          dataset: 'booked_entries',
          filters: [{ field: 'supplierNumber', operator: 'eq', value: 42 }],
        },
      });
      expect(result.isError).not.toBe(true);
      expect(resultJson(result)).toEqual(expect.objectContaining({
        records: [],
        matchStatus: 'no_matches',
      }));
      expect(fetchMock).toHaveBeenCalledOnce();
    }, fetchMock as typeof fetch);
  });

  it('rejects pageSize above the truthful upstream maximum before sending a request', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await withStage1Client(async mcpClient => {
      const result = await mcpClient.callTool({
        name: 'economic_query',
        arguments: { companyId: 'squaremeter', dataset: 'booked_entries', pageSize: 101 },
      });
      expect(result.isError).toBe(true);
      expect(fetchMock).not.toHaveBeenCalled();
    }, fetchMock as unknown as typeof fetch);
  });

  it('fans one supplier-and-period request out across companies in parallel', async () => {
    const requests: Request[] = [];
    let activeSupplierLookups = 0;
    let maxConcurrentSupplierLookups = 0;
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request = new Request(input, init);
      requests.push(request);
      const agreement = Number(request.headers.get('X-AgreementGrantToken')?.replace('grant-', ''));
      if (request.url.includes('/suppliers?')) {
        activeSupplierLookups += 1;
        maxConcurrentSupplierLookups = Math.max(maxConcurrentSupplierLookups, activeSupplierLookups);
        await new Promise(resolve => setTimeout(resolve, 5));
        activeSupplierLookups -= 1;
        return Response.json({
          collection: [{ supplierNumber: agreement, name: 'Møller & Søn', self: 'https://noise.test/supplier' }],
        });
      }
      return Response.json({
        items: [{
          entryNumber: agreement,
          supplierNumber: agreement,
          amount: 100 + agreement,
          amountInBaseCurrency: 100 + agreement,
          currencyCode: 'DKK',
          text: 'Diverse udlæg',
          self: 'https://noise.test/entry',
          metaData: { delete: 'noise' },
          objectVersion: 'noise',
        }],
      });
    });

    const companyConfigs = [
      testCompany('company-1', 'Ejendommen Sølvgade 96 ApS', 1),
      testCompany('company-2', 'Værnedamsvej', 2),
      testCompany('company-3', 'Sølvgade Holding ApS', 3),
    ];
    await withCompaniesClient(companyConfigs, fetchMock as typeof fetch, async mcpClient => {
      const result = await mcpClient.callTool({
        name: 'economic_supplier_transactions',
        arguments: {
          supplierName: 'Møller & Søn',
          fromDate: '2023-01-01',
          toDate: '2026-12-31',
          pageSize: 100,
          maxRecordsPerCompany: 100,
        },
      });
      const parsed = resultJson(result) as {
        complete: boolean;
        summary: { companiesSearched: number; companiesWithMatches: number };
        results: Array<{
          company: { displayName: string };
          status: string;
          transactions: Array<Record<string, unknown>>;
          summary: { baseCurrencyTotal: number };
        }>;
      };
      expect(parsed.complete).toBe(true);
      expect(parsed.summary).toMatchObject({ companiesSearched: 3, companiesWithMatches: 3 });
      expect(parsed.results.map(item => item.company.displayName)).toEqual([
        'Ejendommen Sølvgade 96 ApS',
        'Sølvgade Holding ApS',
        'Værnedamsvej',
      ]);
      expect(parsed.results.every(item => item.status === 'matched')).toBe(true);
      expect(parsed.results[0]?.transactions[0]).toEqual(expect.objectContaining({ text: 'Diverse udlæg' }));
      expect(parsed.results[0]?.transactions[0]).not.toHaveProperty('self');
      expect(parsed.results[0]?.transactions[0]).not.toHaveProperty('metaData');
      expect(parsed.results[0]?.transactions[0]).not.toHaveProperty('objectVersion');
      expect(maxConcurrentSupplierLookups).toBeGreaterThan(1);
      expect(requests).toHaveLength(6);
    });
  });

  it('requires one company when supplierNumber is used', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await withStage1Client(async mcpClient => {
      const result = await mcpClient.callTool({
        name: 'economic_supplier_transactions',
        arguments: {
          supplierNumber: 42,
          fromDate: '2026-01-01',
          toDate: '2026-12-31',
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(/exactly one companyId/i);
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
        name: 'economic_create_sales_invoice_draft',
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
        name: 'economic_create_journal_draft_entry',
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
        name: 'economic_create_sales_invoice_draft',
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

async function withCompaniesClient(
  companies: Stage1CompanyConfig[],
  fetchImpl: typeof fetch,
  action: (client: Client) => Promise<void>,
): Promise<void> {
  const server = createStage1Server({ companies, clientOptions: { fetchImpl } });
  const client = new Client({ name: 'stage1-multi-company-test', version: '1.0.0' });
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

function testCompany(companyId: string, displayName: string, number: number): Stage1CompanyConfig {
  return {
    companyId,
    displayName,
    agreementNumber: String(100_000 + number),
    enabled: true,
    access: { readUserOids: ['*'], draftUserOids: ['*'] },
    credentials: { appSecretToken: 'shared-app', agreementGrantToken: `grant-${number}` },
  };
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
