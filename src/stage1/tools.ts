import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import type { EconomicClient } from '../economic/client.js';
import { callEndpoint } from '../economic/endpoints.js';
import { prepareOperation, verifyPreparedOperation } from '../economic/operations.js';
import type { EconomicPolicy } from '../economic/policy.js';
import { writeAuditEvent } from '../economic/audit.js';
import { formatUnknownError } from '../errors.js';
import { validateExpectedAgreement } from './agreement.js';
import { STAGE1_ALLOWED_TOOLS, type Stage1ToolName } from './allowlist.js';
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
  expectedAgreementNumber?: string | number;
  policy?: EconomicPolicy;
}

export function registerStage1Tools(
  server: McpServer,
  client: EconomicClient,
  options: RegisterStage1ToolsOptions = {},
): void {
  registerTool(server, options, 'stage1_check_connection', {
    title: 'Check Stage 1 e-conomic connection',
    description: 'Validate the configured e-conomic credentials with a GET request.',
    inputSchema: {},
    annotations: readAnnotations(),
  }, async () => jsonToolResult(await client.rest('/')));

  registerTool(server, options, 'stage1_get_company_context', {
    title: 'Get Stage 1 company context',
    description: 'Read the connected company and agreement context from e-conomic.',
    inputSchema: {},
    annotations: readAnnotations(),
  }, async () => jsonToolResult(await client.rest('/self')));

  registerPagedReadTool(server, client, options, 'stage1_search_entities', {
    title: 'Search Stage 1 entities',
    description: 'Read an allowlisted e-conomic entity collection with bounded paging.',
    defaultServiceId: 'rest',
    defaultResource: 'customers',
  });

  registerTool(server, options, 'stage1_get_entity', {
    title: 'Get one Stage 1 entity',
    description: 'Read one entity by catalog service, resource, and number. URLs are not accepted.',
    inputSchema: {
      serviceId: stage1ServiceIdSchema,
      resource: z.string().trim().min(1).max(200),
      number: numberSchema,
    },
    annotations: readAnnotations(),
  }, async input => jsonToolResult(await executeStage1Read(client, {
    serviceId: input.serviceId,
    resource: input.resource,
    number: input.number,
  })));

  registerPagedReadTool(server, client, options, 'stage1_get_customer_overview', {
    title: 'Get Stage 1 customer overview',
    description: 'Read customers and customer reference data.',
    defaultServiceId: 'customers',
    defaultResource: 'Customers',
  });
  registerPagedReadTool(server, client, options, 'stage1_get_supplier_overview', {
    title: 'Get Stage 1 supplier overview',
    description: 'Read suppliers and supplier reference data.',
    defaultServiceId: 'rest',
    defaultResource: 'suppliers',
  });
  registerPagedReadTool(server, client, options, 'stage1_get_product_overview', {
    title: 'Get Stage 1 product overview',
    description: 'Read products, groups, prices, and units.',
    defaultServiceId: 'rest',
    defaultResource: 'products',
  });
  registerPagedReadTool(server, client, options, 'stage1_get_accounting_entries', {
    title: 'Get Stage 1 accounting entries',
    description: 'Read draft or booked accounting entries without posting changes.',
    defaultServiceId: 'booked-entries',
    defaultResource: 'booked-entries',
  });
  registerPagedReadTool(server, client, options, 'stage1_get_sales_documents', {
    title: 'Get Stage 1 sales documents',
    description: 'Read invoices, drafts, orders, or quotes.',
    defaultServiceId: 'rest',
    defaultResource: 'invoices/booked',
  });
  registerPagedReadTool(server, client, options, 'stage1_get_project_overview', {
    title: 'Get Stage 1 project overview',
    description: 'Read projects, groups, employees, activities, and time-entry context.',
    defaultServiceId: 'projects',
    defaultResource: 'Projects',
  });
  registerPagedReadTool(server, client, options, 'stage1_get_document', {
    title: 'Get Stage 1 document metadata',
    description: 'Read allowlisted document metadata and references.',
    defaultServiceId: 'documents',
    defaultResource: 'AttachedDocuments',
  });
  registerPagedReadTool(server, client, options, 'stage1_get_report', {
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
      serviceId: stage1ServiceIdSchema,
      pathTemplate: z.string().trim().min(1).max(500),
      pathParams: pathParamsSchema,
      ...commonReadShape,
    },
    annotations: readAnnotations(),
  }, async input => jsonToolResult(await executeStage1Read(client, input)));

  registerTool(server, options, 'stage1_create_sales_invoice_draft', {
    title: 'Create an unbooked sales invoice draft',
    description: 'Create one validated e-conomic sales invoice draft. Never books or sends it.',
    inputSchema: {
      draft: invoiceDraftSchema,
      reference: z.string().trim().min(1).max(255).optional(),
      reason: z.string().trim().min(8).max(500),
      idempotencyKey: z.string().trim().min(8).max(200),
    },
    annotations: writeAnnotations(),
  }, async input => {
    const body = input.reference
      ? { ...input.draft, references: { ...(input.draft.references ?? {}), other: input.reference } }
      : input.draft;
    return jsonToolResult(await createStage1Draft({
      client,
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
      entry: journalDraftSchema,
      reference: z.string().trim().min(1).max(255).optional(),
      reason: z.string().trim().min(8).max(500),
      idempotencyKey: z.string().trim().min(8).max(200),
    },
    annotations: writeAnnotations(),
  }, async input => jsonToolResult(await createStage1Draft({
    client,
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
  })));
}

interface DraftCreationInput {
  client: EconomicClient;
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
  const decision = checkStage1Policy({
    capability: input.tool,
    serviceId: input.serviceId,
    method: 'POST',
    path: input.path,
    body: input.body,
  }, input.options.policy);

  await writeAuditEvent({
    tool: input.tool,
    action: 'policy_check',
    serviceId: input.serviceId,
    method: 'POST',
    path: input.path,
    idempotencyKey: input.idempotencyKey,
    allowed: decision.allowed,
    reason: decision.reason,
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

  try {
    await validateExpectedAgreement(
      input.client,
      input.options.expectedAgreementNumber,
    );
    await writeAuditEvent({
      tool: input.tool,
      action: 'agreement_check',
      serviceId: 'rest',
      method: 'GET',
      path: '/self',
      idempotencyKey: input.idempotencyKey,
      allowed: true,
      reason: 'expected agreement verified',
      status: 'ok',
    });
  } catch (error) {
    await writeAuditEvent({
      tool: input.tool,
      action: 'agreement_check',
      serviceId: 'rest',
      method: 'GET',
      path: '/self',
      idempotencyKey: input.idempotencyKey,
      allowed: false,
      reason: 'expected agreement validation failed',
      status: 'error',
      error: formatUnknownError(error),
    });
    throw error;
  }

  try {
    const response = await callEndpoint(input.client, {
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
    });

    return {
      success: true,
      type: input.type,
      ...(number !== undefined ? { number } : {}),
      status: 'draft',
      ...(reference !== undefined ? { reference } : {}),
    };
  } catch (error) {
    await writeAuditEvent({
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
      error: formatUnknownError(error),
    });
    throw error;
  }
}

function registerPagedReadTool(
  server: McpServer,
  client: EconomicClient,
  options: RegisterStage1ToolsOptions,
  name: Exclude<Stage1ToolName, 'stage1_check_connection' | 'stage1_get_company_context' | 'stage1_get_entity' | 'stage1_read_economic' | 'stage1_create_sales_invoice_draft' | 'stage1_create_journal_draft_entry'>,
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
      serviceId: stage1ServiceIdSchema.default(definition.defaultServiceId),
      resource: z.string().trim().min(1).max(200).default(definition.defaultResource),
      number: numberSchema.optional(),
      ...commonReadShape,
    },
    annotations: readAnnotations(),
  }, async input => jsonToolResult(await executeStage1Read(client, input)));
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
    await options.authorize?.(name);
    return handler(...args);
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
