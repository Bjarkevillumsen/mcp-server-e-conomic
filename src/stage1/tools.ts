import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import type { EconomicClient } from '../economic/client.js';
import { callEndpoint } from '../economic/endpoints.js';
import { prepareOperation, verifyPreparedOperation } from '../economic/operations.js';
import type { EconomicPolicy } from '../economic/policy.js';
import { writeAuditEvent } from '../economic/audit.js';
import { EconomicHttpError, formatUnknownError } from '../errors.js';
import { primaryEconomicRole } from './auth.js';
import { validateExpectedAgreement } from './agreement.js';
import { STAGE1_ALLOWED_TOOLS, isStage1WriteTool, type Stage1ToolName } from './allowlist.js';
import {
  type ResolvedStage1Company,
  type Stage1CompanyPermission,
  type Stage1CompanyRegistry,
} from './companies.js';
import {
  categorizeError,
  economicStatusForResult,
  operationCategory,
  type Stage1RequestContext,
  type Stage1TechnicalLogger,
} from './logging.js';
import { checkStage1Policy } from './policy.js';
import {
  executeStage1Read,
  STAGE1_DEFAULT_PAGE_SIZE,
  STAGE1_MAX_PAGE_SIZE,
  STAGE1_MAX_TOTAL_RECORDS,
} from './read.js';
import {
  ECONOMIC_DATASETS,
  ECONOMIC_DATASET_IDS,
  ECONOMIC_FILTER_OPERATORS,
  compactDatasetResult,
  compileDatasetRead,
  removeTechnicalMetadata,
  type EconomicDatasetId,
  type EconomicStructuredFilter,
} from './datasets.js';

const numberSchema = z.union([z.string().trim().min(1), z.number()]);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD).');
const isoDateTimeSchema = z.string().refine(
  value => /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && !Number.isNaN(Date.parse(value)),
  'Expected an ISO date or date-time.',
);
const currencySchema = z.string().trim().regex(/^[A-Z]{3}$/, 'Expected an uppercase ISO 4217 currency code.');
const companyIdSchema = z.string().trim().toLowerCase().regex(
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
  'Expected a companyId returned by economic_list_companies.',
);
const companyInputShape = {
  companyId: companyIdSchema.describe(
    'Required e-conomic company ID. Call economic_list_companies before choosing a company.',
  ),
};

const commonReadShape = {
  page: z.number().int().min(0).max(100).default(0)
    .describe('Zero-based upstream page to start at.'),
  pageSize: z.number().int().min(1).max(STAGE1_MAX_PAGE_SIZE).default(STAGE1_DEFAULT_PAGE_SIZE),
  maxRecords: z.number().int().min(1).max(STAGE1_MAX_TOTAL_RECORDS).default(STAGE1_DEFAULT_PAGE_SIZE)
    .describe('Maximum total records. The server automatically fetches additional pages up to this limit.'),
};

const structuredFilterSchema = z.object({
  field: z.string().trim().min(1).max(100)
    .describe('Dataset-specific field from economic_describe_data.'),
  operator: z.enum(ECONOMIC_FILTER_OPERATORS)
    .describe('eq/ne compare exactly; like is case-insensitive contains; in/nin accept arrays.'),
  value: z.union([
    z.string().max(1_000),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(z.union([z.string().max(1_000), z.number().finite(), z.boolean(), z.null()])).min(1).max(200),
  ]),
});

const structuredSortSchema = z.object({
  field: z.string().trim().min(1).max(100),
  direction: z.enum(['asc', 'desc']).default('asc'),
});

const invoiceLineSchema = z
  .object({
    product: z.object({ productNumber: z.union([z.string().trim().min(1), z.number()]) }).passthrough(),
    quantity: z.number().finite(),
    unitNetPrice: z.number().finite().optional(),
    description: z.string().trim().max(1_000).optional(),
  })
  .passthrough();

const invoiceDraftSchema = z
  .object({
    currency: currencySchema,
    customer: z.object({ customerNumber: z.number().int().refine(value => value !== 0) }).passthrough(),
    date: isoDateSchema,
    layout: z.object({ layoutNumber: z.number().int().min(1) }).passthrough(),
    paymentTerms: z.object({ paymentTermsNumber: z.number().int().min(1) }).passthrough(),
    recipient: z
      .object({
        name: z.string().trim().min(1).max(255),
        vatZone: z.object({ vatZoneNumber: z.number().int().min(1) }).passthrough(),
      })
      .passthrough(),
    lines: z.array(invoiceLineSchema).min(1).max(500),
    references: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const journalDraftSchema = z
  .object({
    entryTypeNumber: z.number().int().min(0),
    journalNumber: z.number().int().min(1),
    date: isoDateTimeSchema,
    amount: z.number().finite().refine(value => value !== 0, 'Draft entry amount must not be zero.'),
    currency: currencySchema,
    voucherNumber: z.number().int().min(0).max(999_999_999).optional(),
    text: z.string().trim().max(500).optional(),
  })
  .passthrough();

export type Stage1ToolAuthorizer = (toolName: Stage1ToolName) => void | Promise<void>;

export interface RegisterStage1ToolsOptions {
  authorize?: Stage1ToolAuthorizer;
  policy?: EconomicPolicy;
  requestContext?: Stage1RequestContext;
  logger?: Stage1TechnicalLogger;
}

export function registerStage1Tools(
  server: McpServer,
  companies: Stage1CompanyRegistry,
  options: RegisterStage1ToolsOptions = {},
): void {
  registerTool(server, options, 'economic_list_companies', {
    title: 'List authorized e-conomic companies',
    description:
      'List every e-conomic company the signed-in user may access. Names are returned as Unicode. Use companyId in company-specific tools.',
    inputSchema: {},
    annotations: readAnnotations(),
  }, async () => jsonToolResult({ companies: companies.listAuthorized(options.requestContext?.principal) }));

  registerTool(server, options, 'economic_get_company_context', {
    title: 'Get e-conomic company context',
    description: 'Validate the selected connection and read its company/agreement context. Technical links and metadata are removed.',
    inputSchema: companyInputShape,
    annotations: readAnnotations(),
  }, async input => companyReadResult(
    companies,
    options,
    input.companyId,
    async client => removeTechnicalMetadata(await client.rest('/self')),
  ));

  registerTool(server, options, 'economic_describe_data', {
    title: 'Discover supported e-conomic data',
    description:
      'List supported dataset IDs or describe one dataset, including its valid filter fields, operators, sorting support, and examples. Call this before economic_query when unsure.',
    inputSchema: {
      dataset: z.enum(ECONOMIC_DATASET_IDS).optional()
        .describe('Omit to list all supported datasets; provide one ID for full filter documentation.'),
    },
    annotations: readAnnotations(),
  }, async input => jsonToolResult(describeEconomicData(input.dataset)));

  registerTool(server, options, 'economic_query', {
    title: 'Query validated e-conomic data',
    description:
      'Read one supported dataset with validated structured filters. Example: dataset=booked_entries, filters=[{field:supplierNumber,operator:eq,value:42},{field:date,operator:gte,value:2026-01-01}]. Unknown fields/operators fail before e-conomic is called. like is case-insensitive contains; in/nin accept arrays. pageSize is at most 100 and maxRecords auto-pages up to 500.',
    inputSchema: {
      ...companyInputShape,
      dataset: z.enum(ECONOMIC_DATASET_IDS)
        .describe('Allowlisted dataset ID from economic_describe_data; resource/service names are not accepted.'),
      recordNumber: numberSchema.optional().describe('Fetch one record by number; cannot be combined with filters or sort.'),
      filters: z.array(structuredFilterSchema).min(1).max(20).optional()
        .describe('All predicates are combined with AND. Field/operator pairs are validated for the selected dataset.'),
      sort: z.array(structuredSortSchema).min(1).max(8).optional(),
      ...commonReadShape,
    },
    annotations: readAnnotations(),
  }, async input => {
    const company = resolveCompany(companies, options, input.companyId, 'read');
    const readInput = compileDatasetRead({
      dataset: input.dataset,
      recordNumber: input.recordNumber,
      filters: input.filters,
      sort: input.sort,
      page: input.page,
      pageSize: input.pageSize,
      maxRecords: input.maxRecords,
    });
    const result = compactDatasetResult(input.dataset, await executeStage1Read(company.client, readInput));
    return jsonToolResult({
      company: compactCompany(company),
      query: {
        dataset: input.dataset,
        ...(input.recordNumber !== undefined ? { recordNumber: input.recordNumber } : {}),
        ...(input.filters ? { filters: input.filters } : {}),
        ...(input.sort ? { sort: input.sort } : {}),
      },
      ...result,
    });
  });

  registerTool(server, options, 'economic_supplier_transactions', {
    title: 'Find supplier transactions across companies',
    description:
      'Find booked entries for one supplier in an inclusive date period. supplierName can fan out across all authorized companies in parallel and resolves each company\'s own supplier number. supplierNumber is company-specific and therefore requires exactly one companyId. Returns explicit no_matches, supplier_not_found, or error states per company and compact totals.',
    inputSchema: {
      companyIds: z.array(companyIdSchema).min(1).max(100).optional()
        .describe('Companies to search. Omit with supplierName to search all authorized companies.'),
      supplierName: z.string().trim().min(1).max(255).optional()
        .describe('Exact supplier name, matched case-insensitively in each company.'),
      supplierNumber: z.number().int().positive().optional()
        .describe('Exact company-specific supplier number. Requires exactly one companyId.'),
      fromDate: isoDateSchema.describe('Inclusive start date (YYYY-MM-DD).'),
      toDate: isoDateSchema.describe('Inclusive end date (YYYY-MM-DD).'),
      pageSize: z.number().int().min(1).max(STAGE1_MAX_PAGE_SIZE).default(STAGE1_DEFAULT_PAGE_SIZE),
      maxRecordsPerCompany: z.number().int().min(1).max(STAGE1_MAX_TOTAL_RECORDS).default(STAGE1_DEFAULT_PAGE_SIZE)
        .describe('Maximum returned entries per company. Defaults to 100; raise deliberately up to 500.'),
    },
    annotations: readAnnotations(),
  }, async input => jsonToolResult(await supplierTransactions(companies, options, input)));

  registerTool(server, options, 'economic_create_sales_invoice_draft', {
    title: 'Create an unbooked sales invoice draft',
    description: 'Create one validated e-conomic sales invoice draft. Never books or sends it.',
    inputSchema: {
      ...companyInputShape,
      draft: invoiceDraftSchema,
      reference: z.string().trim().min(1).max(255).optional(),
      reason: z.string().trim().min(8).max(500),
      idempotencyKey: z.string().trim().min(8).max(200),
    },
    annotations: writeAnnotations(),
  }, async input => {
    const company = resolveCompany(companies, options, input.companyId, 'draft');
    const body = input.reference
      ? { ...input.draft, references: { ...(input.draft.references ?? {}), other: input.reference } }
      : input.draft;
    return jsonToolResult(await createStage1Draft({
      company,
      options,
      tool: 'economic_create_sales_invoice_draft',
      type: 'sales_invoice_draft',
      serviceId: 'rest',
      path: '/invoices/drafts',
      body,
      reason: input.reason,
      idempotencyKey: input.idempotencyKey,
      reference: input.reference,
      numberFields: ['draftInvoiceNumber', 'number'],
    }));
  });

  registerTool(server, options, 'economic_create_journal_draft_entry', {
    title: 'Create an unbooked journal draft entry',
    description: 'Create one validated e-conomic journal draft entry. Never books it or registers payment.',
    inputSchema: {
      ...companyInputShape,
      entry: journalDraftSchema,
      reference: z.string().trim().min(1).max(255).optional(),
      reason: z.string().trim().min(8).max(500),
      idempotencyKey: z.string().trim().min(8).max(200),
    },
    annotations: writeAnnotations(),
  }, async input => {
    const company = resolveCompany(companies, options, input.companyId, 'draft');
    return jsonToolResult(await createStage1Draft({
    company,
    options,
    tool: 'economic_create_journal_draft_entry',
    type: 'journal_draft_entry',
    serviceId: 'journals',
    path: '/draft-entries',
    body: input.entry,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    reference: input.reference ?? input.entry.text,
    numberFields: ['entryNumber', 'voucherNumber', 'number'],
    }));
  });
}

interface SupplierTransactionsInput {
  companyIds?: string[];
  supplierName?: string;
  supplierNumber?: number;
  fromDate: string;
  toDate: string;
  pageSize: number;
  maxRecordsPerCompany: number;
}

function describeEconomicData(datasetId?: EconomicDatasetId): Record<string, unknown> {
  const filterSyntax = {
    combination: 'All filters are combined with AND.',
    underlyingDsl: {
      note: 'Clients send structured filters. The server compiles them to e-conomic syntax after validation.',
      mapping: 'eq->$eq:, ne->$ne:, gt->$gt:, gte->$gte:, lt->$lt:, lte->$lte:, like->$like:*value*, in->$in:[...], nin->$nin:[...].',
      conjunction: '$and:',
    },
    operators: {
      eq: 'Exact equality.',
      ne: 'Not equal.',
      gt: 'Greater than.',
      gte: 'Greater than or equal.',
      lt: 'Less than.',
      lte: 'Less than or equal.',
      like: 'Case-insensitive contains match for supported text fields.',
      in: 'Value is in an array of 1-200 values.',
      nin: 'Value is not in an array of 1-200 values.',
    },
    validation: 'Dataset, field, operator, value type, and sortability are validated locally before any e-conomic request.',
  };

  if (datasetId) {
    const dataset = ECONOMIC_DATASETS[datasetId];
    return {
      dataset: datasetDescription(dataset),
      filterSyntax,
      paging: { pageSizeMin: 1, pageSizeMax: STAGE1_MAX_PAGE_SIZE, maxRecords: STAGE1_MAX_TOTAL_RECORDS },
    };
  }

  return {
    datasets: ECONOMIC_DATASET_IDS.map(id => {
      const dataset = ECONOMIC_DATASETS[id];
      return { id, title: dataset.title, description: dataset.description };
    }),
    nextStep: 'Call economic_describe_data with one dataset ID for valid fields, operators, sorting, and examples.',
  };
}

function datasetDescription(dataset: (typeof ECONOMIC_DATASETS)[EconomicDatasetId]) {
  return {
    id: dataset.id,
    title: dataset.title,
    description: dataset.description,
    upstream: { serviceId: dataset.serviceId, resource: dataset.resource },
    filterFields: dataset.filterFields,
    examples: dataset.examples,
  };
}

async function supplierTransactions(
  companies: Stage1CompanyRegistry,
  options: RegisterStage1ToolsOptions,
  input: SupplierTransactionsInput,
): Promise<Record<string, unknown>> {
  const hasName = Boolean(input.supplierName);
  const hasNumber = input.supplierNumber !== undefined;
  if (hasName === hasNumber) {
    throw new Error('Provide exactly one of supplierName or supplierNumber.');
  }
  if (input.fromDate > input.toDate) {
    throw new Error('fromDate must be on or before toDate.');
  }

  const authorizedIds = companies
    .listAuthorized(options.requestContext?.principal)
    .filter(company => company.permissions.read)
    .map(company => company.companyId);
  const companyIds = input.companyIds
    ? [...new Set(input.companyIds)]
    : authorizedIds;
  if (companyIds.length === 0) {
    throw new Error('No readable companies were selected.');
  }
  if (hasNumber && (!input.companyIds || companyIds.length !== 1)) {
    throw new Error('supplierNumber is company-specific and requires exactly one companyId. Use supplierName for cross-company searches.');
  }

  const selected = companyIds.map(companyId => resolveCompany(companies, options, companyId, 'read'));
  const results = await mapWithConcurrency(selected, 4, company => supplierTransactionsForCompany(company, input));
  const errorCount = results.filter(result => result.status === 'error').length;
  if (errorCount === results.length) {
    throw new Error(`Supplier transaction search failed for all ${results.length} selected companies: ${results.map(result => `${result.company.companyId}: ${result.error}`).join('; ')}`);
  }

  const truncatedCount = results.filter(result => result.status === 'matched' && result.page?.truncated).length;
  return {
    query: {
      ...(input.supplierName ? { supplierName: input.supplierName } : { supplierNumber: input.supplierNumber }),
      fromDate: input.fromDate,
      toDate: input.toDate,
      companyIds,
    },
    complete: errorCount === 0 && truncatedCount === 0,
    summary: {
      companiesSearched: results.length,
      companiesWithMatches: results.filter(result => result.status === 'matched').length,
      companiesWithoutMatches: results.filter(result => result.status === 'no_matches').length,
      suppliersNotFound: results.filter(result => result.status === 'supplier_not_found').length,
      errors: errorCount,
      truncatedCompanies: truncatedCount,
    },
    results,
  };
}

interface SupplierCompanyResult {
  company: ReturnType<typeof compactCompany>;
  status: 'matched' | 'no_matches' | 'supplier_not_found' | 'error';
  supplier?: Record<string, unknown>;
  transactions?: unknown[];
  summary?: Record<string, unknown>;
  page?: { truncated: boolean; [key: string]: unknown };
  error?: string;
}

async function supplierTransactionsForCompany(
  company: ResolvedStage1Company,
  input: SupplierTransactionsInput,
): Promise<SupplierCompanyResult> {
  try {
    const supplier = input.supplierNumber !== undefined
      ? { supplierNumber: input.supplierNumber }
      : await resolveSupplierByName(company, input.supplierName as string);
    if (!supplier) {
      return { company: compactCompany(company), status: 'supplier_not_found' };
    }

    const supplierNumber = asPositiveInteger(supplier.supplierNumber);
    if (supplierNumber === undefined) {
      throw new Error('The matched supplier did not contain a valid supplierNumber.');
    }
    const filters: EconomicStructuredFilter[] = [
      { field: 'supplierNumber', operator: 'eq', value: supplierNumber },
      { field: 'date', operator: 'gte', value: `${input.fromDate}T00:00:00.000Z` },
      { field: 'date', operator: 'lte', value: `${input.toDate}T23:59:59.999Z` },
    ];
    const readInput = compileDatasetRead({
      dataset: 'booked_entries',
      filters,
      pageSize: input.pageSize,
      maxRecords: input.maxRecordsPerCompany,
    });
    const compact = compactDatasetResult('booked_entries', await executeStage1Read(company.client, readInput));
    const transactions = Array.isArray(compact.records) ? compact.records : [];
    return {
      company: compactCompany(company),
      status: compact.matchStatus,
      supplier: removeTechnicalMetadata(supplier) as Record<string, unknown>,
      transactions,
      summary: summarizeSupplierEntries(transactions),
      page: compact.page,
    };
  } catch (error) {
    return {
      company: compactCompany(company),
      status: 'error',
      error: formatUnknownError(error),
    };
  }
}

async function resolveSupplierByName(
  company: ResolvedStage1Company,
  supplierName: string,
): Promise<Record<string, unknown> | undefined> {
  const readInput = compileDatasetRead({
    dataset: 'suppliers',
    filters: [{ field: 'name', operator: 'eq', value: supplierName }],
    pageSize: 100,
    maxRecords: 100,
  });
  const response = await executeStage1Read(company.client, readInput);
  const exactMatches = collectionRecords(response.data)
    .filter(isRecord)
    .filter(supplier => typeof supplier.name === 'string' &&
      supplier.name.localeCompare(supplierName, 'da', { sensitivity: 'base' }) === 0);
  if (exactMatches.length > 1) {
    throw new Error(`Supplier name "${supplierName}" is ambiguous in this company; use supplierNumber with one companyId.`);
  }
  return exactMatches[0];
}

function summarizeSupplierEntries(entries: unknown[]): Record<string, unknown> {
  let baseCurrencyTotal = 0;
  let baseCurrencyValues = 0;
  const currencyTotals = new Map<string, number>();
  for (const item of entries) {
    if (!isRecord(item)) continue;
    const baseAmount = asFiniteNumber(item.amountInBaseCurrency);
    if (baseAmount !== undefined) {
      baseCurrencyTotal += baseAmount;
      baseCurrencyValues += 1;
    }
    const amount = asFiniteNumber(item.amount);
    const currency = typeof item.currencyCode === 'string' ? item.currencyCode : undefined;
    if (amount !== undefined && currency) {
      currencyTotals.set(currency, (currencyTotals.get(currency) ?? 0) + amount);
    }
  }
  return {
    transactionCount: entries.length,
    ...(baseCurrencyValues > 0 ? { baseCurrencyTotal: roundAmount(baseCurrencyTotal) } : {}),
    currencyTotals: Object.fromEntries(
      [...currencyTotals.entries()].sort(([left], [right]) => left.localeCompare(right))
        .map(([currency, amount]) => [currency, roundAmount(amount)]),
    ),
  };
}

function collectionRecords(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.collection)) return value.collection;
  if (isRecord(value) && Array.isArray(value.items)) return value.items;
  return [];
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) break;
      results[index] = await worker(items[index] as T);
    }
  }));
  return results;
}

function asPositiveInteger(value: unknown): number | undefined {
  const number = asFiniteNumber(value);
  return number !== undefined && Number.isInteger(number) && number > 0 ? number : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

function roundAmount(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

interface DraftCreationInput {
  company: ResolvedStage1Company;
  options: RegisterStage1ToolsOptions;
  tool: 'economic_create_sales_invoice_draft' | 'economic_create_journal_draft_entry';
  type: 'sales_invoice_draft' | 'journal_draft_entry';
  serviceId: 'rest' | 'journals';
  path: '/invoices/drafts' | '/draft-entries';
  body: Record<string, unknown>;
  reason: string;
  idempotencyKey: string;
  reference?: string;
  numberFields: string[];
}

async function createStage1Draft(input: DraftCreationInput): Promise<Record<string, unknown>> {
  const startedAt = Date.now();
  const decision = checkStage1Policy({
    capability: input.tool,
    serviceId: input.serviceId,
    method: 'POST',
    path: input.path,
    body: input.body,
  }, input.options.policy);

  await writeAuditEvent({
    ...draftAuditIdentity(input),
    tool: input.tool,
    action: 'policy_check',
    serviceId: input.serviceId,
    method: 'POST',
    path: input.path,
    idempotencyKey: input.idempotencyKey,
    allowed: decision.allowed,
    reason: decision.reason,
    result: decision.allowed ? undefined : 'denied',
  });

  if (!decision.allowed) {
    throw new Error(`Stage 1 write blocked by policy: ${decision.reason}`);
  }

  const operation = verifyPreparedOperation(prepareOperation({
    capability: input.tool,
    serviceId: input.serviceId,
    method: 'POST',
    pathTemplate: input.path,
    body: input.body,
    reason: input.reason,
  }));

  let agreementNumber: string;
  try {
    const agreement = await validateExpectedAgreement(
      input.company.client,
      input.company.agreementNumber,
    );
    agreementNumber = agreement.agreementNumber;
    await writeAuditEvent({
      ...draftAuditIdentity(input),
      tool: input.tool,
      action: 'agreement_check',
      serviceId: 'rest',
      method: 'GET',
      path: '/self',
      idempotencyKey: input.idempotencyKey,
      allowed: true,
      reason: 'expected agreement verified',
      status: 'ok',
      result: 'success',
      agreementNumber,
    });
  } catch (error) {
    await writeAuditEvent({
      ...draftAuditIdentity(input),
      tool: input.tool,
      action: 'agreement_check',
      serviceId: 'rest',
      method: 'GET',
      path: '/self',
      idempotencyKey: input.idempotencyKey,
      allowed: false,
      reason: 'expected agreement validation failed',
      status: 'error',
      result: 'failure',
      error: formatUnknownError(error),
    });
    throw error;
  }

  try {
    const response = await callEndpoint(input.company.client, {
      serviceId: operation.serviceId,
      method: operation.method,
      pathTemplate: operation.pathTemplate,
      pathParams: operation.pathParams,
      query: operation.query,
      body: operation.body,
      idempotencyKey: input.idempotencyKey,
    });
    const number = extractFirstField(response, input.numberFields);
    const reference = input.reference ?? extractFirstField(response, ['reference', 'self']);

    await writeAuditEvent({
      ...draftAuditIdentity(input),
      tool: input.tool,
      action: 'create',
      serviceId: input.serviceId,
      method: 'POST',
      path: input.path,
      operationHash: operation.operationHash,
      idempotencyKey: input.idempotencyKey,
      allowed: true,
      reason: decision.reason,
      status: 'ok',
      result: 'success',
      policyResult: 'allowed',
      economicHttpStatus: 201,
      durationMs: Date.now() - startedAt,
      agreementNumber,
      draftNumber: number,
      draftReference: reference,
    });

    return {
      success: true,
      company: publicCompany(input.company),
      type: input.type,
      ...(number !== undefined ? { number } : {}),
      status: 'draft',
      ...(reference !== undefined ? { reference } : {}),
    };
  } catch (error) {
    await writeAuditEvent({
      ...draftAuditIdentity(input),
      tool: input.tool,
      action: 'create',
      serviceId: input.serviceId,
      method: 'POST',
      path: input.path,
      operationHash: operation.operationHash,
      idempotencyKey: input.idempotencyKey,
      allowed: true,
      reason: decision.reason,
      status: 'error',
      result: 'failure',
      error: formatUnknownError(error),
      errorCategory: categorizeError(error),
      policyResult: 'allowed',
      economicHttpStatus: error instanceof EconomicHttpError ? error.status : undefined,
      durationMs: Date.now() - startedAt,
      agreementNumber,
    });
    throw error;
  }
}

function registerTool(
  server: McpServer,
  options: RegisterStage1ToolsOptions,
  name: Stage1ToolName,
  definition: any,
  handler: (...args: any[]) => any,
): void {
  if (!STAGE1_ALLOWED_TOOLS.includes(name)) {
    throw new Error(`Attempted to register a tool outside STAGE1_ALLOWED_TOOLS: ${name}`);
  }

  server.registerTool(name, definition, async (...args: any[]) => {
    const startedAt = Date.now();
    try {
      await options.authorize?.(name);
      const result = await handler(...args);
      const draft = isStage1WriteTool(name) ? extractDraftResult(result) : undefined;
      options.logger?.log({
        requestId: options.requestContext?.requestId ?? 'stdio',
        principal: options.requestContext?.principal,
        tool: name,
        companyId: companyIdFromToolArguments(args),
        operationCategory: operationCategory(name),
        policyResult: 'allowed',
        economicHttpStatus: economicStatusForResult(name),
        durationMs: Date.now() - startedAt,
        draftNumber: draft?.number,
        draftReference: draft?.reference,
      });
      return result;
    } catch (error) {
      options.logger?.log({
        requestId: options.requestContext?.requestId ?? 'stdio',
        principal: options.requestContext?.principal,
        tool: name,
        companyId: companyIdFromToolArguments(args),
        operationCategory: operationCategory(name),
        policyResult: categorizeError(error) === 'policy_denied' ? 'denied' : 'not_applicable',
        economicHttpStatus: error instanceof EconomicHttpError ? error.status : undefined,
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  });
}

function readAnnotations() {
  return {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
}

function writeAnnotations() {
  return {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  };
}

function extractFirstField(value: unknown, fields: string[]): string | number | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  for (const field of fields) {
    const candidate = record[field];
    if (typeof candidate === 'string' || typeof candidate === 'number') {
      return candidate;
    }
  }

  return undefined;
}

function auditIdentity(options: RegisterStage1ToolsOptions) {
  const principal = options.requestContext?.principal;
  return {
    requestId: options.requestContext?.requestId,
    tenantId: principal?.tenantId,
    userOid: principal?.userOid,
    username: principal?.username,
    role: principal ? primaryEconomicRole(principal) : undefined,
  };
}

function draftAuditIdentity(input: DraftCreationInput) {
  return {
    ...auditIdentity(input.options),
    companyId: input.company.companyId,
    companyDisplayName: input.company.displayName,
    agreementNumber: input.company.agreementNumber,
  };
}

async function companyReadResult(
  companies: Stage1CompanyRegistry,
  options: RegisterStage1ToolsOptions,
  companyId: string,
  action: (client: EconomicClient) => Promise<unknown>,
) {
  const company = resolveCompany(companies, options, companyId, 'read');
  const result = await action(company.client);
  return jsonToolResult({
    company: publicCompany(company),
    result,
  });
}

function resolveCompany(
  companies: Stage1CompanyRegistry,
  options: RegisterStage1ToolsOptions,
  companyId: string,
  permission: Stage1CompanyPermission,
): ResolvedStage1Company {
  return companies.resolve(companyId, options.requestContext?.principal, permission);
}

function publicCompany(company: ResolvedStage1Company) {
  return {
    companyId: company.companyId,
    displayName: company.displayName,
    agreementNumber: company.agreementNumber,
  };
}

function compactCompany(company: ResolvedStage1Company) {
  return {
    companyId: company.companyId,
    displayName: company.displayName,
  };
}

function companyIdFromToolArguments(args: any[]): string | undefined {
  const input = args[0];
  return isRecord(input) && typeof input.companyId === 'string' ? input.companyId : undefined;
}

function extractDraftResult(result: unknown): { number?: string | number; reference?: string | number } | undefined {
  if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
  const block = result.content[0];
  if (!isRecord(block) || typeof block.text !== 'string') return undefined;
  try {
    const parsed = JSON.parse(block.text) as unknown;
    if (!isRecord(parsed)) return undefined;
    return {
      ...(typeof parsed.number === 'string' || typeof parsed.number === 'number' ? { number: parsed.number } : {}),
      ...(typeof parsed.reference === 'string' || typeof parsed.reference === 'number' ? { reference: parsed.reference } : {}),
    };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonToolResult(data: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(data),
      },
    ],
  };
}
