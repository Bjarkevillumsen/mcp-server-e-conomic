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
  STAGE1_READ_SERVICE_IDS,
} from './read.js';

const stage1ServiceIds = STAGE1_READ_SERVICE_IDS as [string, ...string[]];
const stage1ServiceIdSchema = z.enum(stage1ServiceIds);
const pathParamsSchema = z.record(z.string(), z.union([z.string(), z.number()])).optional();
const numberSchema = z.union([z.string().trim().min(1), z.number()]);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected an ISO date (YYYY-MM-DD).');
const isoDateTimeSchema = z.string().refine(
  value => /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) && !Number.isNaN(Date.parse(value)),
  'Expected an ISO date or date-time.',
);
const currencySchema = z.string().trim().regex(/^[A-Z]{3}$/, 'Expected an uppercase ISO 4217 currency code.');
const companyIdSchema = z.string().trim().toLowerCase().regex(
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
  'Expected a companyId returned by stage1_list_companies.',
);
const companyInputShape = {
  companyId: companyIdSchema.describe(
    'Required e-conomic company ID. Call stage1_list_companies before choosing a company.',
  ),
};

const commonReadShape = {
  filter: z.string().trim().max(4_000).optional(),
  sort: z.string().trim().max(1_000).optional(),
  cursor: z.string().trim().max(512).optional(),
  page: z.number().int().min(0).max(1_000_000).default(0),
  pageSize: z.number().int().min(1).max(STAGE1_MAX_PAGE_SIZE).default(STAGE1_DEFAULT_PAGE_SIZE),
  maxRecords: z.number().int().min(1).max(STAGE1_MAX_TOTAL_RECORDS).default(STAGE1_DEFAULT_PAGE_SIZE),
};

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
  registerTool(server, options, 'stage1_list_companies', {
    title: 'List authorized e-conomic companies',
    description:
      'List the e-conomic companies the signed-in user may access. Use the returned companyId in every other tool call.',
    inputSchema: {},
    annotations: readAnnotations(),
  }, async () => jsonToolResult({ companies: companies.listAuthorized(options.requestContext?.principal) }));

  registerTool(server, options, 'stage1_check_connection', {
    title: 'Check Stage 1 e-conomic connection',
    description: 'Validate the selected e-conomic company credentials with a GET request.',
    inputSchema: companyInputShape,
    annotations: readAnnotations(),
  }, async input => companyReadResult(companies, options, input.companyId, client => client.rest('/')));

  registerTool(server, options, 'stage1_get_company_context', {
    title: 'Get Stage 1 company context',
    description: 'Read the selected company and agreement context from e-conomic.',
    inputSchema: companyInputShape,
    annotations: readAnnotations(),
  }, async input => companyReadResult(companies, options, input.companyId, client => client.rest('/self')));

  registerPagedReadTool(server, companies, options, 'stage1_search_entities', {
    title: 'Search Stage 1 entities',
    description: 'Read an allowlisted e-conomic entity collection with bounded paging.',
    defaultServiceId: 'rest',
    defaultResource: 'customers',
  });

  registerTool(server, options, 'stage1_get_entity', {
    title: 'Get one Stage 1 entity',
    description: 'Read one entity by catalog service, resource, and number. URLs are not accepted.',
    inputSchema: {
      ...companyInputShape,
      serviceId: stage1ServiceIdSchema,
      resource: z.string().trim().min(1).max(200),
      number: numberSchema,
    },
    annotations: readAnnotations(),
  }, async input => companyReadResult(companies, options, input.companyId, client => executeStage1Read(client, {
      serviceId: input.serviceId,
      resource: input.resource,
      number: input.number,
    })));

  registerPagedReadTool(server, companies, options, 'stage1_get_customer_overview', {
    title: 'Get Stage 1 customer overview',
    description: 'Read customers and customer reference data.',
    defaultServiceId: 'customers',
    defaultResource: 'Customers',
  });
  registerPagedReadTool(server, companies, options, 'stage1_get_supplier_overview', {
    title: 'Get Stage 1 supplier overview',
    description: 'Read suppliers and supplier reference data.',
    defaultServiceId: 'rest',
    defaultResource: 'suppliers',
  });
  registerPagedReadTool(server, companies, options, 'stage1_get_product_overview', {
    title: 'Get Stage 1 product overview',
    description: 'Read products, groups, prices, and units.',
    defaultServiceId: 'rest',
    defaultResource: 'products',
  });
  registerPagedReadTool(server, companies, options, 'stage1_get_accounting_entries', {
    title: 'Get Stage 1 accounting entries',
    description: 'Read draft or booked accounting entries without posting changes.',
    defaultServiceId: 'booked-entries',
    defaultResource: 'booked-entries',
  });
  registerPagedReadTool(server, companies, options, 'stage1_get_sales_documents', {
    title: 'Get Stage 1 sales documents',
    description: 'Read invoices, drafts, orders, or quotes.',
    defaultServiceId: 'rest',
    defaultResource: 'invoices/booked',
  });
  registerPagedReadTool(server, companies, options, 'stage1_get_project_overview', {
    title: 'Get Stage 1 project overview',
    description: 'Read projects, groups, employees, activities, and time-entry context.',
    defaultServiceId: 'projects',
    defaultResource: 'Projects',
  });
  registerPagedReadTool(server, companies, options, 'stage1_get_document', {
    title: 'Get Stage 1 document metadata',
    description: 'Read allowlisted document metadata and references.',
    defaultServiceId: 'documents',
    defaultResource: 'AttachedDocuments',
  });
  registerPagedReadTool(server, companies, options, 'stage1_get_report', {
    title: 'Get Stage 1 report data',
    description: 'Read accounts, booked entries, budgets, and accounting-year data.',
    defaultServiceId: 'accounts',
    defaultResource: 'Accounts',
  });

  registerTool(server, options, 'stage1_read_economic', {
    title: 'Read a cataloged e-conomic endpoint',
    description:
      'GET-only access to an upstream-cataloged relative path. Full URLs, hostnames, methods, traversal, unknown services, and webhooks are rejected.',
    inputSchema: {
      ...companyInputShape,
      serviceId: stage1ServiceIdSchema,
      pathTemplate: z.string().trim().min(1).max(500),
      pathParams: pathParamsSchema,
      ...commonReadShape,
    },
    annotations: readAnnotations(),
  }, async input => companyReadResult(companies, options, input.companyId, client => executeStage1Read(client, input)));

  registerTool(server, options, 'stage1_create_sales_invoice_draft', {
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
      tool: 'stage1_create_sales_invoice_draft',
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

  registerTool(server, options, 'stage1_create_journal_draft_entry', {
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
    tool: 'stage1_create_journal_draft_entry',
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

interface DraftCreationInput {
  company: ResolvedStage1Company;
  options: RegisterStage1ToolsOptions;
  tool: 'stage1_create_sales_invoice_draft' | 'stage1_create_journal_draft_entry';
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

function registerPagedReadTool(
  server: McpServer,
  companies: Stage1CompanyRegistry,
  options: RegisterStage1ToolsOptions,
  name: Exclude<Stage1ToolName, 'stage1_list_companies' | 'stage1_check_connection' | 'stage1_get_company_context' | 'stage1_get_entity' | 'stage1_read_economic' | 'stage1_create_sales_invoice_draft' | 'stage1_create_journal_draft_entry'>,
  definition: {
    title: string;
    description: string;
    defaultServiceId: string;
    defaultResource: string;
  },
): void {
  registerTool(server, options, name, {
    title: definition.title,
    description: definition.description,
    inputSchema: {
      ...companyInputShape,
      serviceId: stage1ServiceIdSchema.default(definition.defaultServiceId),
      resource: z.string().trim().min(1).max(200).default(definition.defaultResource),
      number: numberSchema.optional(),
      ...commonReadShape,
    },
    annotations: readAnnotations(),
  }, async input => companyReadResult(
    companies,
    options,
    input.companyId,
    client => executeStage1Read(client, input),
  ));
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
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}
