#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { EconomicClient } from '../economic/client.js';
import { type EconomicPolicy } from '../economic/policy.js';
import { validateExpectedAgreement } from '../stage1/agreement.js';
import { checkStage1Policy } from '../stage1/policy.js';
import { createStage1Server } from '../stage1/server.js';
import {
  STAGE1_LIVE_EXPECTED_AGREEMENT,
  STAGE1_LIVE_TEST_REFERENCE,
  validateLiveAcceptanceEnvironment,
} from './live-guards.js';

type AcceptanceMode = 'reads' | 'invoice-draft' | 'journal-draft' | 'negative';

interface CliOptions {
  mode: AcceptanceMode;
  payloadPath?: string;
}

const readCases = [
  { domain: 'customers', serviceId: 'rest', pathTemplate: '/customers' },
  { domain: 'suppliers', serviceId: 'rest', pathTemplate: '/suppliers' },
  { domain: 'products', serviceId: 'rest', pathTemplate: '/products' },
  { domain: 'chart-of-accounts', serviceId: 'rest', pathTemplate: '/accounts' },
  { domain: 'invoices', serviceId: 'rest', pathTemplate: '/invoices/booked' },
  { domain: 'accounting-entries', serviceId: 'booked-entries', pathTemplate: '/booked-entries/paged' },
  { domain: 'projects', serviceId: 'projects', pathTemplate: '/Projects/paged' },
  { domain: 'budgets', serviceId: 'budgets', pathTemplate: '/budget-figures/paged' },
] as const;

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.mode === 'negative') {
    process.stdout.write(`${JSON.stringify(runNegativePolicyChecks(), null, 2)}\n`);
    return;
  }

  const isWrite = options.mode === 'invoice-draft' || options.mode === 'journal-draft';
  validateLiveAcceptanceEnvironment(process.env, { write: isWrite });

  const economicClient = new EconomicClient();
  const agreement = await validateExpectedAgreement(economicClient, STAGE1_LIVE_EXPECTED_AGREEMENT);

  const output = await withStage1Client(economicClient, async client => {
    if (options.mode === 'reads') return runReadAcceptance(client);
    if (!options.payloadPath) throw new Error(`${options.mode} requires --payload <path-to-json>.`);
    const payload = await readJsonObject(options.payloadPath);
    return options.mode === 'invoice-draft'
      ? createAndVerifyInvoiceDraft(client, payload)
      : createAndVerifyJournalDraft(client, payload);
  });

  process.stdout.write(`${JSON.stringify({
    testedAt: new Date().toISOString(),
    mode: options.mode,
    expectedAgreementNumber: STAGE1_LIVE_EXPECTED_AGREEMENT,
    actualAgreementNumber: agreement.agreementNumber,
    result: output,
  }, null, 2)}\n`);
}

async function runReadAcceptance(client: Client): Promise<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  const company = await client.callTool({
    name: 'stage1_get_company_context',
    arguments: { companyId: liveCompanyId() },
  });
  results.push({ domain: 'company-context', status: company.isError ? 'failed' : 'passed' });

  for (const testCase of readCases) {
    const result = await client.callTool({
      name: 'stage1_read_economic',
      arguments: {
        companyId: liveCompanyId(),
        serviceId: testCase.serviceId,
        pathTemplate: testCase.pathTemplate,
        pageSize: 1,
        maxRecords: 1,
      },
    });
    results.push({
      domain: testCase.domain,
      status: result.isError ? classifyReadFailure(result) : 'passed',
    });
  }

  const filtered = await client.callTool({
    name: 'stage1_read_economic',
    arguments: {
      companyId: liveCompanyId(),
      serviceId: 'rest',
      pathTemplate: '/customers',
      filter: 'name$like:*',
      page: 0,
      pageSize: 1,
      maxRecords: 1,
    },
  });
  results.push({ domain: 'filtering-and-pagination', status: filtered.isError ? 'failed' : 'passed' });

  return {
    results,
    note: 'unsupported means the API returned 403 or 404, commonly because the agreement lacks that optional module',
  };
}

async function createAndVerifyInvoiceDraft(
  client: Client,
  draft: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const creation = await client.callTool({
    name: 'stage1_create_sales_invoice_draft',
    arguments: {
      companyId: liveCompanyId(),
      draft,
      reference: STAGE1_LIVE_TEST_REFERENCE,
      reason: 'Approved Stage 1 live acceptance invoice draft',
      idempotencyKey: `stage1-invoice-${randomUUID()}`,
    },
  });
  const normalized = requireSuccessfulToolResult(creation);
  const number = normalized.number;
  if (typeof number !== 'string' && typeof number !== 'number') {
    throw new Error('Invoice draft was created but no draft number was returned; stop and inspect manually.');
  }

  const readBack = requireSuccessfulToolResult(await client.callTool({
    name: 'stage1_get_entity',
    arguments: { companyId: liveCompanyId(), serviceId: 'rest', resource: 'invoices/drafts', number },
  }));
  assertDraftReadBack(nestedReadData(readBack), 'invoice');

  return {
    success: true,
    type: 'sales_invoice_draft',
    number,
    reference: STAGE1_LIVE_TEST_REFERENCE,
    status: 'draft',
    readBackVerified: true,
  };
}

async function createAndVerifyJournalDraft(
  client: Client,
  suppliedEntry: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const existingText = typeof suppliedEntry.text === 'string' ? suppliedEntry.text.trim() : '';
  const entry = {
    ...suppliedEntry,
    text: existingText.includes(STAGE1_LIVE_TEST_REFERENCE)
      ? existingText
      : `${STAGE1_LIVE_TEST_REFERENCE}${existingText ? ` - ${existingText}` : ''}`,
  };
  const creation = await client.callTool({
    name: 'stage1_create_journal_draft_entry',
    arguments: {
      companyId: liveCompanyId(),
      entry,
      reference: STAGE1_LIVE_TEST_REFERENCE,
      reason: 'Approved Stage 1 live acceptance journal draft',
      idempotencyKey: `stage1-journal-${randomUUID()}`,
    },
  });
  const normalized = requireSuccessfulToolResult(creation);
  const number = normalized.number;
  if (typeof number !== 'string' && typeof number !== 'number') {
    throw new Error('Journal draft was created but no draft number was returned; stop and inspect manually.');
  }

  const readBack = requireSuccessfulToolResult(await client.callTool({
    name: 'stage1_get_entity',
    arguments: { companyId: liveCompanyId(), serviceId: 'journals', resource: 'draft-entries', number },
  }));
  assertDraftReadBack(nestedReadData(readBack), 'journal');

  return {
    success: true,
    type: 'journal_draft_entry',
    number,
    reference: STAGE1_LIVE_TEST_REFERENCE,
    status: 'draft',
    readBackVerified: true,
  };
}

function runNegativePolicyChecks(): Record<string, unknown> {
  const policy: EconomicPolicy = {
    writesEnabled: true,
    bookingEnabled: false,
    allowedCapabilities: ['stage1_create_sales_invoice_draft', 'stage1_create_journal_draft_entry'],
    allowedServices: ['rest', 'journals'],
    allowedMethods: ['POST'],
    deniedPathPatterns: [],
  };
  const environment = { ECONOMIC_ENABLE_WRITES: 'true', ECONOMIC_ENABLE_BOOKING: 'false' };
  const checks = [
    ['invoice-booking', 'stage1_create_sales_invoice_draft', 'rest', 'POST', '/invoices/drafts/1/book'],
    ['journal-booking', 'stage1_create_journal_draft_entry', 'journals', 'POST', '/draft-entries/1/book'],
    ['payment', 'economic_prepare_payment_registration', 'journals', 'POST', '/draft-entries'],
    ['delete', 'stage1_create_sales_invoice_draft', 'rest', 'DELETE', '/invoices/drafts/1'],
    ['customer-update', 'economic_prepare_customer_change', 'rest', 'PUT', '/customers/1'],
    ['supplier-update', 'economic_prepare_supplier_change', 'rest', 'PUT', '/suppliers/1'],
    ['product-update', 'economic_prepare_product_change', 'rest', 'PUT', '/products/1'],
    ['account-update', 'economic_prepare_account_change', 'rest', 'PUT', '/accounts/1'],
  ] as const;

  const results = checks.map(([name, capability, serviceId, method, path]) => ({
    name,
    blockedBeforeEconomicRequest: !checkStage1Policy(
      { capability, serviceId, method, path },
      policy,
      environment,
    ).allowed,
  }));
  if (results.some(result => !result.blockedBeforeEconomicRequest)) {
    throw new Error('One or more Stage 1 negative policy checks unexpectedly allowed a mutation.');
  }
  return { success: true, economicRequestsSent: 0, results };
}

async function withStage1Client<T>(economicClient: EconomicClient, action: (client: Client) => Promise<T>): Promise<T> {
  const server = createStage1Server({
    client: economicClient,
    expectedAgreementNumber: STAGE1_LIVE_EXPECTED_AGREEMENT,
  });
  const client = new Client({ name: 'stage1-live-acceptance', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await action(client);
  } finally {
    await client.close();
    await server.close();
  }
}

function requireSuccessfulToolResult(result: unknown): Record<string, unknown> {
  const record = isRecord(result) ? result : {};
  if (record.isError === true) throw new Error('Stage 1 MCP tool returned an error; no retry was attempted.');
  const content = Array.isArray(record.content) ? record.content : [];
  const first = isRecord(content[0]) ? content[0] : {};
  if (first.type !== 'text' || typeof first.text !== 'string') {
    throw new Error('Stage 1 MCP tool returned an unexpected response shape.');
  }
  const parsed: unknown = JSON.parse(first.text);
  if (!isRecord(parsed)) throw new Error('Stage 1 MCP tool result was not an object.');
  return parsed;
}

function classifyReadFailure(result: unknown): 'unsupported' | 'failed' {
  const text = JSON.stringify(result);
  return /HTTP\s+(?:403|404)\b/i.test(text) ? 'unsupported' : 'failed';
}

function assertDraftReadBack(data: unknown, type: 'invoice' | 'journal'): void {
  if (!isRecord(data)) throw new Error(`${type} draft read-back returned no object.`);
  if (data.booked === true || data.status === 'booked' || 'bookedInvoiceNumber' in data) {
    throw new Error(`${type} read-back did not prove an unbooked draft state.`);
  }
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isRecord(parsed)) throw new Error('Acceptance payload must be a JSON object.');
  return parsed;
}

function parseCli(args: string[]): CliOptions {
  let mode: AcceptanceMode | undefined;
  let payloadPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--mode') mode = args[++index] as AcceptanceMode | undefined;
    else if (argument === '--payload') payloadPath = args[++index];
    else throw new Error(`Unknown live acceptance argument: ${argument}`);
  }
  if (!mode || !['reads', 'invoice-draft', 'journal-draft', 'negative'].includes(mode)) {
    throw new Error('Use --mode reads|invoice-draft|journal-draft|negative.');
  }
  return { mode, ...(payloadPath ? { payloadPath } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nestedReadData(value: Record<string, unknown>): unknown {
  const result = isRecord(value.result) ? value.result : {};
  return result.data;
}

function liveCompanyId(): string {
  return process.env.ECONOMIC_DEFAULT_COMPANY_ID?.trim().toLowerCase() || 'default';
}

main().catch(error => {
  const message = error instanceof Error ? error.message : 'Unknown live acceptance error';
  process.stderr.write(`${JSON.stringify({ success: false, error: message })}\n`);
  process.exitCode = 1;
});
