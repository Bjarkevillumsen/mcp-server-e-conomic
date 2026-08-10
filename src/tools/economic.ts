import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import type { EconomicClient, HttpMethod, QueryValue } from '../economic/client.js';
import { ECONOMIC_SERVICES, resolveReadPathTemplate, searchCapabilities, getCapability, getSchemaSummary } from '../economic/catalog.js';
import { callEndpoint, type EndpointCallInput } from '../economic/endpoints.js';
import { prepareOperation, verifyPreparedOperation, type PreparedOperation } from '../economic/operations.js';
import { checkPolicy, isBookingCapability } from '../economic/policy.js';
import { MAX_BOOKING_ENTRIES, prepareBooking, prepareOpenItemMatch } from '../economic/bookings.js';
import { writeAuditEvent } from '../economic/audit.js';
import { formatUnknownError } from '../errors.js';

const serviceIds = ECONOMIC_SERVICES.map(service => service.id) as [string, ...string[]];
const serviceIdSchema = z.enum(serviceIds);
const methodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const queryValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]).optional();
const querySchema = z.record(z.string(), queryValueSchema).optional();
const pathParamsSchema = z.record(z.string(), z.union([z.string(), z.number()])).optional();
// Typed as an object (not z.unknown()) so the JSON Schema advertises
// `type: "object"` — without that hint, some MCP clients stringify the
// argument instead of nesting it, which e-conomic then rejects as
// "Expected a JSON with an object as the root element".
const bodySchema = z.record(z.string(), z.unknown()).optional();

const endpointInputSchema = z.object({
  serviceId: serviceIdSchema,
  method: methodSchema.default('GET'),
  pathTemplate: z.string().trim().min(1),
  pathParams: pathParamsSchema,
  query: querySchema,
  body: bodySchema,
  idempotencyKey: z.string().trim().min(8).optional(),
});

const preparedOperationSchema = z.object({
  capability: z.string().trim().min(1),
  serviceId: serviceIdSchema,
  method: methodSchema,
  pathTemplate: z.string().trim().min(1),
  pathParams: pathParamsSchema,
  query: querySchema,
  body: bodySchema,
  dryRun: z.literal(true),
  reason: z.string().trim().min(1),
  operationHash: z.string().trim().min(32),
  policyDecision: z.unknown(),
});

export function registerEconomicTools(server: McpServer, client: EconomicClient): void {
  server.registerTool(
    'economic_search_capabilities',
    {
      title: 'Search e-conomic Capabilities',
      description:
        'Search curated tools, schemas, and allowlisted e-conomic endpoints. Use this first when deciding which e-conomic capability to call.',
      inputSchema: {
        query: z.string().trim().default(''),
        limit: z.number().int().min(1).max(100).default(20),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async input => jsonToolResult(searchCapabilities(input.query, input.limit)),
  );

  server.registerTool(
    'economic_get_capability',
    {
      title: 'Get e-conomic Capability',
      description: 'Return details for a discovered capability, tool, schema, or endpoint.',
      inputSchema: {
        id: z.string().trim().min(1),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async input => jsonToolResult(getCapability(input.id) ?? { error: `Unknown capability: ${input.id}` }),
  );

  server.registerTool(
    'economic_get_schema',
    {
      title: 'Get e-conomic Schema Summary',
      description:
        'Inspect known service/resource schema metadata, including resource names and common filter/sort/pagination fields.',
      inputSchema: {
        serviceId: serviceIdSchema,
        resource: z.string().trim().min(1).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async input => jsonToolResult(getSchemaSummary(input.serviceId, input.resource)),
  );

  server.registerTool(
    'economic_check_connection',
    {
      title: 'Check e-conomic Connection',
      description: 'Validate e-conomic credentials by fetching the REST API root.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => jsonToolResult(await client.rest('/')),
  );

  server.registerTool(
    'economic_get_company_context',
    {
      title: 'Get e-conomic Company Context',
      description:
        'Return the agreement self-service context: company (name, CVR, address), agreement number, application, modules, and settings. Use this to confirm which e-conomic agreement the server is connected to.',
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => jsonToolResult(await client.rest('/self')),
  );

  registerReadTool(server, 'economic_search_entities', client, {
    title: 'Search e-conomic Entities',
    description:
      'List or page through common e-conomic resources such as customers, suppliers, products, accounts, projects, documents, and entries.',
  });

  server.registerTool(
    'economic_get_entity',
    {
      title: 'Get e-conomic Entity',
      description: 'Fetch a single entity by service/resource/number, or by an e-conomic self URL.',
      inputSchema: {
        serviceId: serviceIdSchema.optional(),
        resource: z.string().trim().min(1).optional(),
        number: z.union([z.string().trim().min(1), z.number()]).optional(),
        selfUrl: z.string().url().optional(),
        query: querySchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async input => {
      if (input.selfUrl) {
        assertEconomicUrl(input.selfUrl);
        return jsonToolResult(await client.request({ url: input.selfUrl, query: input.query }));
      }

      if (!input.serviceId || !input.resource || input.number === undefined) {
        throw new Error('Provide either selfUrl or serviceId, resource, and number.');
      }

      return jsonToolResult(
        await callEndpoint(client, {
          serviceId: input.serviceId,
          method: 'GET',
          pathTemplate: `/${input.resource}/{number}`,
          pathParams: { number: input.number },
          query: input.query,
        }),
      );
    },
  );

  registerReadTool(server, 'economic_get_customer_overview', client, {
    title: 'Get Customer Overview',
    description: 'Read customer master data and related customer API resources.',
    defaultServiceId: 'customers',
    defaultResource: 'Customers',
  });
  registerReadTool(server, 'economic_get_supplier_overview', client, {
    title: 'Get Supplier Overview',
    description: 'Read supplier groups or supplier contact data.',
    defaultServiceId: 'rest',
    defaultResource: 'suppliers',
  });
  registerReadTool(server, 'economic_get_product_overview', client, {
    title: 'Get Product Overview',
    description: 'Read products, product groups, price groups, and sales price data.',
    // The OpenAPI products service's /paged and /specialprices paths 404 on
    // e-conomic's side; the classic REST surface (/products, /products/{n})
    // is the reliable path for this resource.
    defaultServiceId: 'rest',
    defaultResource: 'products',
  });
  registerReadTool(server, 'economic_get_sales_document', client, {
    title: 'Get Sales Document',
    description: 'Read draft invoice, booked invoice line, order line, or quote line resources.',
    defaultServiceId: 'q2c',
    defaultResource: 'invoices/drafts',
  });
  registerReadTool(server, 'economic_get_accounting_entries', client, {
    title: 'Get Accounting Entries',
    description: 'Read draft or booked accounting entries.',
    defaultServiceId: 'booked-entries',
    defaultResource: 'booked-entries',
  });
  registerReadTool(server, 'economic_get_project_overview', client, {
    title: 'Get Project Overview',
    description: 'Read projects, employees, activities, and time entries.',
    defaultServiceId: 'projects',
    defaultResource: 'Projects',
  });
  registerReadTool(server, 'economic_get_document', client, {
    title: 'Get Attached Document',
    description: 'Read attached document metadata or PDF payloads.',
    defaultServiceId: 'documents',
    defaultResource: 'AttachedDocuments',
  });
  registerReadTool(server, 'economic_get_report', client, {
    title: 'Get Report Data',
    description: 'Read accounts, booked entries, budgets, and accounting-year resources for reporting.',
    defaultServiceId: 'accounts',
    defaultResource: 'Accounts',
  });
  registerReadTool(server, 'economic_reconcile_open_items', client, {
    title: 'Reconcile Open Items',
    description:
      'Read and return entry data for reconciliation analysis. This tool never posts matches or payments.',
    defaultServiceId: 'booked-entries',
    defaultResource: 'booked-entries',
  });

  server.registerTool(
    'economic_validate_payload',
    {
      title: 'Validate e-conomic Payload',
      description: 'Validate that a candidate operation is allowlisted and report its write policy decision.',
      inputSchema: endpointInputSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async input => {
      const method = input.method as HttpMethod;
      const path = input.pathTemplate;
      const decision = checkPolicy({
        capability: 'economic_call_endpoint',
        serviceId: input.serviceId,
        method,
        path,
        body: input.body,
      });
      return jsonToolResult({
        valid: true,
        endpoint: {
          serviceId: input.serviceId,
          method,
          pathTemplate: input.pathTemplate,
        },
        policyDecision: decision,
      });
    },
  );

  registerPrepareTool(server, 'economic_prepare_customer_change', {
    capability: 'economic_prepare_customer_change',
    title: 'Prepare Customer Change',
    defaultServiceId: 'customers',
    defaultCreatePath: '/Customers',
    defaultUpdatePath: '/Customers/{number}',
  });
  registerPrepareTool(server, 'economic_prepare_supplier_change', {
    capability: 'economic_prepare_supplier_change',
    title: 'Prepare Supplier Change',
    // Supplier master records only exist on the classic REST surface.
    defaultServiceId: 'rest',
    defaultCreatePath: '/suppliers',
    defaultUpdatePath: '/suppliers/{number}',
  });
  registerPrepareTool(server, 'economic_prepare_product_change', {
    capability: 'economic_prepare_product_change',
    title: 'Prepare Product Change',
    defaultServiceId: 'products',
    defaultCreatePath: '/products',
    defaultUpdatePath: '/products/{number}',
  });
  registerPrepareTool(server, 'economic_prepare_product_group_change', {
    capability: 'economic_prepare_product_group_change',
    title: 'Prepare Product Group Change',
    defaultServiceId: 'products',
    defaultCreatePath: '/productgroups',
    defaultUpdatePath: '/productgroups/{number}',
  });
  // The Projects add-on API upserts via the collection: create is POST /X and
  // update is PUT /X (full object incl. its number + objectVersion). Item-level
  // PUT/PATCH (/X/{number}) return HTTP 405; delete is DELETE /X/{number}.
  // Project status, cost types and activities are read-only here (UI-managed).
  registerPrepareTool(server, 'economic_prepare_project_change', {
    capability: 'economic_prepare_project_change',
    title: 'Prepare Project Change',
    defaultServiceId: 'projects',
    defaultCreatePath: '/Projects',
    defaultUpdatePath: '/Projects',
    defaultDeletePath: '/Projects/{number}',
    methods: ['POST', 'PUT', 'DELETE'],
  });
  registerPrepareTool(server, 'economic_prepare_project_group_change', {
    capability: 'economic_prepare_project_group_change',
    title: 'Prepare Project Group Change',
    defaultServiceId: 'projects',
    defaultCreatePath: '/ProjectGroups',
    defaultUpdatePath: '/ProjectGroups',
    defaultDeletePath: '/ProjectGroups/{number}',
    methods: ['POST', 'PUT', 'DELETE'],
  });
  registerPrepareTool(server, 'economic_prepare_employee_change', {
    capability: 'economic_prepare_employee_change',
    title: 'Prepare Employee Change',
    defaultServiceId: 'projects',
    defaultCreatePath: '/Employees',
    defaultUpdatePath: '/Employees',
    defaultDeletePath: '/Employees/{number}',
    methods: ['POST', 'PUT', 'DELETE'],
  });
  // Project time registrations: the API supports create and delete (no update).
  registerPrepareTool(server, 'economic_prepare_time_entry', {
    capability: 'economic_prepare_time_entry',
    title: 'Prepare Project Time Entry',
    defaultServiceId: 'projects',
    defaultCreatePath: '/TimeEntries',
    defaultDeletePath: '/TimeEntries/{number}',
    methods: ['POST', 'DELETE'],
  });
  registerPrepareTool(server, 'economic_prepare_sales_document', {
    capability: 'economic_prepare_sales_document',
    title: 'Prepare Sales Document',
    defaultServiceId: 'q2c',
    defaultCreatePath: '/invoices/drafts',
    defaultUpdatePath: '/invoices/drafts/{number}',
  });
  registerPrepareTool(server, 'economic_prepare_journal_entry', {
    capability: 'economic_prepare_journal_entry',
    title: 'Prepare Journal Entry',
    defaultServiceId: 'journals',
    defaultCreatePath: '/draft-entries',
    defaultUpdatePath: '/draft-entries/{number}',
  });
  registerPrepareTool(server, 'economic_prepare_payment_registration', {
    capability: 'economic_prepare_payment_registration',
    title: 'Prepare Payment Registration',
    defaultServiceId: 'journals',
    defaultCreatePath: '/draft-entries',
    defaultUpdatePath: '/draft-entries/{number}',
  });

  server.registerTool(
    'economic_commit_prepared_operation',
    {
      title: 'Commit Prepared e-conomic Operation',
      description:
        'Execute a prepared write operation after verifying its hash, idempotency key, and policy decision.',
      inputSchema: {
        operation: preparedOperationSchema,
        idempotencyKey: z.string().trim().min(8),
        confirmOperationHash: z.string().trim().min(32),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async input => {
      const operation = verifyPreparedOperation(input.operation as PreparedOperation);

      if (isBookingCapability(operation.capability)) {
        throw new Error(
          'Booking and open-item match operations must be executed with economic_commit_booking, which carries the booking duty.',
        );
      }

      if (input.confirmOperationHash !== operation.operationHash) {
        throw new Error('confirmOperationHash must equal operation.operationHash.');
      }

      const decision = checkPolicy({
        capability: operation.capability,
        serviceId: operation.serviceId,
        method: operation.method,
        path: operation.pathTemplate,
        body: operation.body,
      });

      await writeAuditEvent({
        tool: 'economic_commit_prepared_operation',
        action: 'policy_check',
        serviceId: operation.serviceId,
        method: operation.method,
        path: operation.pathTemplate,
        operationHash: operation.operationHash,
        idempotencyKey: input.idempotencyKey,
        allowed: decision.allowed,
        reason: decision.reason,
      });

      if (!decision.allowed) {
        throw new Error(`Write blocked by policy: ${decision.reason}`);
      }

      try {
        const result = await callEndpoint(client, {
          serviceId: operation.serviceId,
          method: operation.method,
          pathTemplate: operation.pathTemplate,
          pathParams: operation.pathParams,
          query: operation.query,
          body: operation.body,
          idempotencyKey: input.idempotencyKey,
        });

        await writeAuditEvent({
          tool: 'economic_commit_prepared_operation',
          action: 'commit',
          serviceId: operation.serviceId,
          method: operation.method,
          path: operation.pathTemplate,
          operationHash: operation.operationHash,
          idempotencyKey: input.idempotencyKey,
          allowed: true,
          reason: decision.reason,
          status: 'ok',
        });

        return jsonToolResult(result);
      } catch (error) {
        await writeAuditEvent({
          tool: 'economic_commit_prepared_operation',
          action: 'commit',
          serviceId: operation.serviceId,
          method: operation.method,
          path: operation.pathTemplate,
          operationHash: operation.operationHash,
          idempotencyKey: input.idempotencyKey,
          allowed: true,
          reason: decision.reason,
          status: 'error',
          error: formatUnknownError(error),
        });
        throw error;
      }
    },
  );

  server.registerTool(
    'economic_prepare_booking',
    {
      title: 'Prepare Booking of Draft Entries (IRREVERSIBLE on commit)',
      description:
        'Validate and prepare booking of EXPLICIT journal draft entries (never a whole journal). Guardrails run before anything is prepared: every entry must exist in the journal, per-entry amounts pass the policy maxAmount check, and every referenced voucher must have an attached document (requireVoucher=false only when the user has verified documentation elsewhere). Returns the validated entries for user review plus a prepared operation. Booking is IRREVERSIBLE — corrections require reversing entries or credit notes. Execute with economic_commit_booking, which requires the booking duty. This tool itself writes nothing.',
      inputSchema: {
        journalNumber: z.number().int().min(1).describe('Journal (kassekladde) number holding the draft entries.'),
        entryNumbers: z
          .array(z.number().int().min(1))
          .min(1)
          .max(MAX_BOOKING_ENTRIES)
          .describe('Explicit draft entry numbers to book. Never book entries the user has not reviewed.'),
        reason: z.string().trim().min(8).describe('Why these entries are being booked, e.g. the matching bank transaction.'),
        requireVoucher: z.boolean().default(true),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async input => jsonToolResult(await prepareBooking(client, input)),
  );

  server.registerTool(
    'economic_prepare_open_item_match',
    {
      title: 'Prepare Open-Item Match / Udligning (no undo on commit)',
      description:
        'Prepare matching (udligning) of booked open items — customer payments against sales invoices or supplier payments against supplier invoices. All entries must belong to the same customer or supplier ledger. e-conomic has NO API to undo a match (undo is UI-only), so execution requires the booking duty via economic_commit_booking. Find open items with economic_get_accounting_entries (remainder > 0). This tool itself writes nothing.',
      inputSchema: {
        entryIds: z
          .array(z.number().int().min(1))
          .min(2)
          .max(100)
          .describe('Booked entry numbers to match against each other (same customer/supplier).'),
        reason: z.string().trim().min(8),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async input => jsonToolResult(prepareOpenItemMatch(input)),
  );

  server.registerTool(
    'economic_commit_booking',
    {
      title: 'Commit Booking / Open-Item Match (IRREVERSIBLE)',
      description:
        'Execute a prepared booking (economic_prepare_booking) or open-item match (economic_prepare_open_item_match) after verifying its hash and policy. IRREVERSIBLE: booked entries cannot be edited or deleted, and matches cannot be undone via the API. Confirm with the user before calling. Only booking/match operations are accepted — ordinary writes go through economic_commit_prepared_operation.',
      inputSchema: {
        operation: preparedOperationSchema,
        idempotencyKey: z.string().trim().min(8),
        confirmOperationHash: z.string().trim().min(32),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async input => {
      const operation = verifyPreparedOperation(input.operation as PreparedOperation);

      if (!isBookingCapability(operation.capability)) {
        throw new Error(
          'economic_commit_booking only executes booking/match operations. Use economic_commit_prepared_operation for ordinary writes.',
        );
      }

      if (input.confirmOperationHash !== operation.operationHash) {
        throw new Error('confirmOperationHash must equal operation.operationHash.');
      }

      const decision = checkPolicy({
        capability: operation.capability,
        serviceId: operation.serviceId,
        method: operation.method,
        path: operation.pathTemplate,
        body: operation.body,
      });

      await writeAuditEvent({
        tool: 'economic_commit_booking',
        action: 'policy_check',
        serviceId: operation.serviceId,
        method: operation.method,
        path: operation.pathTemplate,
        operationHash: operation.operationHash,
        idempotencyKey: input.idempotencyKey,
        allowed: decision.allowed,
        reason: decision.reason,
      });

      if (!decision.allowed) {
        throw new Error(`Booking blocked by policy: ${decision.reason}`);
      }

      try {
        const result = await callEndpoint(client, {
          serviceId: operation.serviceId,
          method: operation.method,
          pathTemplate: operation.pathTemplate,
          pathParams: operation.pathParams,
          query: operation.query,
          body: operation.body,
          idempotencyKey: input.idempotencyKey,
        });

        await writeAuditEvent({
          tool: 'economic_commit_booking',
          action: 'commit',
          serviceId: operation.serviceId,
          method: operation.method,
          path: operation.pathTemplate,
          operationHash: operation.operationHash,
          idempotencyKey: input.idempotencyKey,
          allowed: true,
          reason: decision.reason,
          status: 'ok',
        });

        return jsonToolResult(result ?? { ok: true, booked: true });
      } catch (error) {
        await writeAuditEvent({
          tool: 'economic_commit_booking',
          action: 'commit',
          serviceId: operation.serviceId,
          method: operation.method,
          path: operation.pathTemplate,
          operationHash: operation.operationHash,
          idempotencyKey: input.idempotencyKey,
          allowed: true,
          reason: decision.reason,
          status: 'error',
          error: formatUnknownError(error),
        });
        throw error;
      }
    },
  );

  server.registerTool(
    'economic_attach_voucher_file',
    {
      title: 'Attach Voucher File',
      description:
        'Upload a binary attachment (typically a PDF) to an existing voucher in a daybook journal. The voucher must already exist.',
      inputSchema: {
        journalNumber: z.union([z.string().trim().min(1), z.number().int()]),
        accountingYear: z.string().trim().min(1),
        voucherNumber: z.union([z.string().trim().min(1), z.number().int()]),
        fileBase64: z.string().trim().min(1),
        contentType: z.string().trim().min(1).default('application/pdf'),
        idempotencyKey: z.string().trim().min(8),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async input => {
      const pathTemplate =
        '/journals/{journalNumber}/vouchers/{accountingYear}-{voucherNumber}/attachment/file';
      const path = pathTemplate
        .replace('{journalNumber}', encodeURIComponent(String(input.journalNumber)))
        .replace('{accountingYear}', encodeURIComponent(input.accountingYear))
        .replace('{voucherNumber}', encodeURIComponent(String(input.voucherNumber)));

      const decision = checkPolicy({
        capability: 'economic_attach_voucher_file',
        serviceId: 'rest',
        method: 'PUT',
        path,
      });

      await writeAuditEvent({
        tool: 'economic_attach_voucher_file',
        action: 'policy_check',
        serviceId: 'rest',
        method: 'PUT',
        path,
        idempotencyKey: input.idempotencyKey,
        allowed: decision.allowed,
        reason: decision.reason,
      });

      if (!decision.allowed) {
        throw new Error(`Attach blocked by policy: ${decision.reason}`);
      }

      const bytes = decodeBase64(input.fileBase64);

      try {
        const result = await client.restRawBody(path, {
          method: 'PUT',
          body: bytes,
          contentType: input.contentType,
          idempotencyKey: input.idempotencyKey,
        });

        await writeAuditEvent({
          tool: 'economic_attach_voucher_file',
          action: 'commit',
          serviceId: 'rest',
          method: 'PUT',
          path,
          idempotencyKey: input.idempotencyKey,
          allowed: true,
          reason: decision.reason,
          status: 'ok',
        });

        return jsonToolResult(result ?? { ok: true, path });
      } catch (error) {
        await writeAuditEvent({
          tool: 'economic_attach_voucher_file',
          action: 'commit',
          serviceId: 'rest',
          method: 'PUT',
          path,
          idempotencyKey: input.idempotencyKey,
          allowed: true,
          reason: decision.reason,
          status: 'error',
          error: formatUnknownError(error),
        });
        throw error;
      }
    },
  );

  server.registerTool(
    'economic_call_endpoint',
    {
      title: 'Call Validated e-conomic Endpoint',
      description:
        'Call an allowlisted e-conomic endpoint. GET calls are enabled by default; mutating calls require write policy and idempotency.',
      inputSchema: endpointInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async input => {
      const endpointInput = input as EndpointCallInput;
      const decision = checkPolicy({
        capability: 'economic_call_endpoint',
        serviceId: endpointInput.serviceId,
        method: endpointInput.method,
        path: endpointInput.pathTemplate,
        body: endpointInput.body,
      });

      if (!decision.allowed) {
        throw new Error(`Endpoint call blocked by policy: ${decision.reason}`);
      }

      if (endpointInput.method !== 'GET' && !endpointInput.idempotencyKey) {
        throw new Error('Mutating endpoint calls require idempotencyKey.');
      }

      return jsonToolResult(await callEndpoint(client, endpointInput));
    },
  );

  server.registerTool(
    'economic_attach_sales_invoice_file',
    {
      title: 'Attach Sales Invoice File',
      description:
        'Upload a supporting document (typically a PDF) to an existing draft sales invoice so it can travel with the invoice. The draft must already exist. The file is sent as multipart/form-data via POST, as the e-conomic draft invoice attachment endpoint requires.',
      inputSchema: {
        draftInvoiceNumber: z.union([z.string().trim().min(1), z.number().int()]),
        fileBase64: z.string().trim().min(1),
        fileName: z.string().trim().min(1).default('attachment.pdf'),
        idempotencyKey: z.string().trim().min(8),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async input => {
      const path = `/invoices/drafts/${encodeURIComponent(String(input.draftInvoiceNumber))}/attachment/file`;

      const decision = checkPolicy({
        capability: 'economic_attach_sales_invoice_file',
        serviceId: 'rest',
        method: 'POST',
        path,
      });

      await writeAuditEvent({
        tool: 'economic_attach_sales_invoice_file',
        action: 'policy_check',
        serviceId: 'rest',
        method: 'POST',
        path,
        idempotencyKey: input.idempotencyKey,
        allowed: decision.allowed,
        reason: decision.reason,
      });

      if (!decision.allowed) {
        throw new Error(`Attach blocked by policy: ${decision.reason}`);
      }

      const form = buildMultipartFormData('file', sanitizeFileName(input.fileName), decodeBase64(input.fileBase64));

      try {
        const result = await client.restRawBody(path, {
          method: 'POST',
          body: form.bytes,
          contentType: `multipart/form-data; boundary=${form.boundary}`,
          idempotencyKey: input.idempotencyKey,
        });

        await writeAuditEvent({
          tool: 'economic_attach_sales_invoice_file',
          action: 'commit',
          serviceId: 'rest',
          method: 'POST',
          path,
          idempotencyKey: input.idempotencyKey,
          allowed: true,
          reason: decision.reason,
          status: 'ok',
        });

        return jsonToolResult(result ?? { ok: true, path });
      } catch (error) {
        await writeAuditEvent({
          tool: 'economic_attach_sales_invoice_file',
          action: 'commit',
          serviceId: 'rest',
          method: 'POST',
          path,
          idempotencyKey: input.idempotencyKey,
          allowed: true,
          reason: decision.reason,
          status: 'error',
          error: formatUnknownError(error),
        });
        throw error;
      }
    },
  );
}

function sanitizeFileName(name: string): string {
  return name.replace(/[\r\n"\\]/g, '_');
}

function buildMultipartFormData(
  fieldName: string,
  fileName: string,
  fileBytes: Uint8Array,
): { bytes: Uint8Array; boundary: string } {
  const boundary = `----economicMcp${Math.abs(hashString(`${fileName}:${fileBytes.length}`)).toString(36)}`;
  const encoder = new TextEncoder();
  const head = encoder.encode(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${fileName}"\r\nContent-Type: application/pdf\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const bytes = new Uint8Array(head.length + fileBytes.length + tail.length);
  bytes.set(head, 0);
  bytes.set(fileBytes, head.length);
  bytes.set(tail, head.length + fileBytes.length);
  return { bytes, boundary };
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return hash;
}

function registerReadTool(
  server: McpServer,
  name: string,
  client: EconomicClient,
  options: {
    title: string;
    description: string;
    defaultServiceId?: string;
    defaultResource?: string;
  },
): void {
  server.registerTool(
    name,
    {
      title: options.title,
      description: options.description,
      inputSchema: {
        serviceId: serviceIdSchema.default(options.defaultServiceId ?? 'rest'),
        resource: z.string().trim().min(1).default(options.defaultResource ?? 'customers'),
        number: z.union([z.string().trim().min(1), z.number()]).optional(),
        paged: z.boolean().default(true),
        query: querySchema,
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async input => {
      const pathTemplate = resolveReadPathTemplate(input.serviceId, input.resource, {
        number: input.number,
        paged: input.paged,
      });
      const pathParams = input.number === undefined ? undefined : { number: input.number };

      return jsonToolResult(
        await callEndpoint(client, {
          serviceId: input.serviceId,
          method: 'GET',
          pathTemplate,
          pathParams,
          query: input.query,
        }),
      );
    },
  );
}

function registerPrepareTool(
  server: McpServer,
  name: string,
  options: {
    capability: string;
    title: string;
    defaultServiceId: string;
    defaultCreatePath: string;
    // Update path for PUT/PATCH. Several e-conomic OpenAPI services (notably the
    // Projects add-on) do not support item-level PUT (`/x/{number}` returns 405)
    // and instead upsert via the collection (`PUT /x` with the key in the body).
    // For those, set defaultUpdatePath to the collection path (same as create).
    defaultUpdatePath?: string;
    // Delete path (item-level). Defaults to defaultUpdatePath when omitted.
    defaultDeletePath?: string;
    // Restrict the offered methods (e.g. ['POST', 'DELETE'] for time entries,
    // which the API creates and deletes but cannot update).
    methods?: HttpMethod[];
  },
): void {
  const methods = options.methods ?? ['POST', 'PUT', 'PATCH', 'DELETE'];
  server.registerTool(
    name,
    {
      title: options.title,
      description:
        'Prepare a policy-checkable dry-run write operation. This does not call e-conomic until economic_commit_prepared_operation is used.',
      inputSchema: {
        serviceId: serviceIdSchema.default(options.defaultServiceId),
        method: z.enum(methods as [HttpMethod, ...HttpMethod[]]).default('POST'),
        pathTemplate: z.string().trim().min(1).optional(),
        pathParams: pathParamsSchema,
        query: querySchema,
        body: bodySchema,
        reason: z.string().trim().min(1),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async input => {
      const pathTemplate =
        input.pathTemplate ??
        (input.method === 'POST'
          ? options.defaultCreatePath
          : input.method === 'DELETE'
            ? (options.defaultDeletePath ?? options.defaultUpdatePath)
            : options.defaultUpdatePath);
      if (!pathTemplate) {
        throw new Error(
          `${name}: no default path template for method ${input.method}; pass an explicit pathTemplate.`,
        );
      }
      return jsonToolResult(
        prepareOperation({
          capability: options.capability,
          serviceId: input.serviceId,
          method: input.method,
          pathTemplate,
          pathParams: input.pathParams,
          query: input.query,
          body: input.body,
          reason: input.reason,
        }),
      );
    },
  );
}

function assertEconomicUrl(urlValue: string): void {
  const url = new URL(urlValue);
  if (!['restapi.e-conomic.com', 'apis.e-conomic.com'].includes(url.hostname)) {
    throw new Error('selfUrl must point to restapi.e-conomic.com or apis.e-conomic.com.');
  }
}

function decodeBase64(value: string): Uint8Array {
  const cleaned = value.replace(/\s+/g, '');
  return new Uint8Array(Buffer.from(cleaned, 'base64'));
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
