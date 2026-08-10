import type { HttpMethod } from './client.js';

export type ApiSurface = 'rest' | 'openapi';
export type CapabilityRisk = 'read' | 'draft' | 'commit' | 'dangerous';

export interface EconomicService {
  id: string;
  name: string;
  surface: ApiSurface;
  servicePath: string;
  version?: string;
  resources: string[];
}

export interface EndpointOperation {
  id: string;
  serviceId: string;
  surface: ApiSurface;
  method: HttpMethod;
  pathTemplate: string;
  summary: string;
  risk: CapabilityRisk;
}

export interface Capability {
  id: string;
  title: string;
  kind: 'tool' | 'endpoint' | 'schema';
  description: string;
  risk: CapabilityRisk;
  source: string;
  keywords: string[];
}

export const ECONOMIC_SERVICES: EconomicService[] = [
  {
    id: 'rest',
    name: 'REST root',
    surface: 'rest',
    servicePath: '',
    resources: [
      'accounts',
      'accounting-years',
      'currencies',
      'customers',
      'customer-groups',
      'departments',
      'departmental-distributions',
      'employees',
      'entries',
      // Master data needed to build and reference sales documents (invoice
      // layout, payment terms, and product units).
      'layouts',
      'payment-terms',
      'units',
      'invoices',
      // Booked/open invoice collections used for read projections (revenue,
      // open and overdue receivables). e-conomic exposes these as REST
      // sub-collections of /invoices with query paging (skippages/pagesize).
      'invoices/booked',
      'invoices/drafts',
      'invoices/unpaid',
      'invoices/overdue',
      'invoices/paid',
      'invoices/sent',
      'journals',
      'orders',
      'products',
      'product-groups',
      'quotes',
      'suppliers',
      'supplier-groups',
      'vat-accounts',
      'vat-zones',
    ],
  },
  {
    id: 'customers',
    name: 'Customers',
    surface: 'openapi',
    servicePath: 'customersapi/v3.1.0',
    version: '3.1.0',
    resources: ['Contacts', 'Customers', 'DeliveryLocations', 'Setup'],
  },
  {
    id: 'products',
    name: 'Products',
    surface: 'openapi',
    servicePath: 'productsapi/v2.0.0',
    version: '2.0.0',
    resources: ['pricegroups', 'productgroups', 'products', 'salespriceincurrencies', 'specialprices'],
  },
  {
    id: 'accounts',
    name: 'Accounts',
    surface: 'openapi',
    servicePath: 'accountsapi/v7.0.0',
    version: '7.0.0',
    resources: ['Accounts', 'KeyFigureCodes', 'TotalIntervals'],
  },
  {
    id: 'projects',
    name: 'Projects',
    surface: 'openapi',
    servicePath: 'projectsapi/v1.1.0',
    version: '1.1.0',
    resources: ['Projects', 'ProjectGroups', 'CostTypes', 'ProjectStatuses', 'Employees', 'EmployeeGroups', 'TimeEntries', 'Activities', 'ActivityGroups'],
  },
  {
    id: 'journals',
    name: 'Journals',
    surface: 'openapi',
    // v15 adds POST /journals/{n}/bookdraftentries (booking of explicit entries).
    servicePath: 'journalsapi/v15.0.0',
    version: '15.0.0',
    resources: ['draft-entries', 'journals', 'accruals'],
  },
  {
    id: 'q2c',
    name: 'Quote to Cash',
    surface: 'openapi',
    servicePath: 'q2capi/v5.1.0',
    version: '5.1.0',
    resources: ['invoices/drafts', 'invoices/booked/lines', 'orders', 'quotes'],
  },
  {
    id: 'suppliers',
    name: 'Suppliers',
    surface: 'openapi',
    servicePath: 'suppliersapi/v2.0.0',
    version: '2.0.0',
    resources: ['Contacts', 'Groups'],
  },
  {
    id: 'subscriptions',
    name: 'Subscriptions',
    surface: 'openapi',
    servicePath: 'subscriptionsapi/v6.0.3',
    version: '6.0.3',
    resources: ['Subscribers', 'SubscriptionLines', 'Subscriptions'],
  },
  {
    id: 'dimensions',
    name: 'Dimensions',
    surface: 'openapi',
    servicePath: 'dimensionsapi/v5.3.0',
    version: '5.3.0',
    resources: ['dimensions', 'values', 'distributions', 'dimension-data/accounts'],
  },
  {
    id: 'documents',
    name: 'Documents',
    surface: 'openapi',
    servicePath: 'documentsapi/v3.0.1',
    version: '3.0.1',
    resources: ['AttachedDocuments'],
  },
  {
    id: 'booked-entries',
    name: 'Booked Entries',
    surface: 'openapi',
    servicePath: 'bookedEntriesapi/v4.0.0',
    version: '4.0.0',
    resources: ['booked-entries', 'booked-entries/matched-pairs'],
  },
  {
    id: 'accounting-years',
    name: 'Accounting Years',
    surface: 'openapi',
    servicePath: 'accountingyearsapi/v2.0.1',
    version: '2.0.1',
    resources: ['AccountingYears', 'accountingYears/periods'],
  },
  {
    id: 'budgets',
    name: 'Budgets',
    surface: 'openapi',
    servicePath: 'budgetsapi/v2.0.0',
    version: '2.0.0',
    resources: ['budget-figures'],
  },
  {
    id: 'webhooks',
    name: 'Webhooks',
    surface: 'openapi',
    servicePath: 'webhooksapi/v1.0.0',
    version: '1.0.0',
    resources: ['EventTypes', 'webhooks'],
  },
];

export const CURATED_CAPABILITIES: Capability[] = [
  toolCapability('economic_check_connection', 'Check e-conomic connection', 'Validate credentials and return API context.', 'read', ['auth', 'setup']),
  toolCapability('economic_get_company_context', 'Get company context', 'Return the agreement self-service context: company (name, CVR), agreement number, application, modules, and settings.', 'read', ['company', 'agreement', 'self']),
  toolCapability('economic_search_entities', 'Search entities', 'Find customers, suppliers, products, accounts, projects, and documents with filters.', 'read', ['search']),
  toolCapability('economic_get_entity', 'Get entity', 'Fetch one resource by service/resource/id or REST self URL.', 'read', ['lookup']),
  toolCapability('economic_get_customer_overview', 'Get customer overview', 'Inspect customer master data and related contacts/delivery locations.', 'read', ['customer']),
  toolCapability('economic_get_supplier_overview', 'Get supplier overview', 'Inspect supplier master data and related contacts/groups.', 'read', ['supplier']),
  toolCapability('economic_get_product_overview', 'Get product overview', 'Inspect product, product group, price group, and price information.', 'read', ['product']),
  toolCapability('economic_get_sales_document', 'Get sales document', 'Fetch draft invoices, booked invoice lines, order lines, or quote lines.', 'read', ['invoice', 'order', 'quote']),
  toolCapability('economic_get_accounting_entries', 'Get accounting entries', 'Read draft or booked accounting entries with paging/filter support.', 'read', ['journal', 'entry']),
  toolCapability('economic_get_project_overview', 'Get project overview', 'Read project, employee, activity, and time-entry context.', 'read', ['project']),
  toolCapability('economic_get_document', 'Get attached document', 'Read attached document metadata or PDF data.', 'read', ['document', 'pdf']),
  toolCapability('economic_get_report', 'Get report data', 'Read balances, entries, budgets, and other reporting-oriented resources.', 'read', ['report']),
  toolCapability('economic_reconcile_open_items', 'Reconcile open items', 'Analyze customer/supplier/account entries without posting changes.', 'read', ['reconciliation']),
  toolCapability('economic_validate_payload', 'Validate payload', 'Validate a candidate write payload against known endpoint and policy constraints.', 'read', ['validation']),
  toolCapability('economic_prepare_customer_change', 'Prepare customer change', 'Create a dry-run operation for customer master data changes.', 'draft', ['customer', 'write']),
  toolCapability('economic_prepare_supplier_change', 'Prepare supplier change', 'Create a dry-run operation for supplier master data changes (classic REST /suppliers).', 'draft', ['supplier', 'write']),
  toolCapability('economic_prepare_product_change', 'Prepare product change', 'Create a dry-run operation for product master data changes.', 'draft', ['product', 'write']),
  toolCapability('economic_prepare_sales_document', 'Prepare sales document', 'Create a dry-run operation for draft invoices, orders, or quotes.', 'draft', ['invoice', 'order', 'quote', 'write']),
  toolCapability('economic_prepare_journal_entry', 'Prepare journal entry', 'Create a dry-run operation for journal draft entries.', 'draft', ['journal', 'entry', 'write']),
  toolCapability('economic_prepare_payment_registration', 'Prepare payment registration', 'Create a dry-run operation for payment registration.', 'draft', ['payment', 'write']),
  toolCapability('economic_prepare_product_group_change', 'Prepare product group change', 'Create a dry-run operation for product group master data.', 'draft', ['product', 'group', 'write']),
  toolCapability('economic_prepare_project_change', 'Prepare project change', 'Create or update a project in the Projects add-on (collection upsert via PUT /Projects).', 'draft', ['project', 'write']),
  toolCapability('economic_prepare_project_group_change', 'Prepare project group change', 'Create or update a project group in the Projects add-on (collection upsert).', 'draft', ['project', 'group', 'write']),
  toolCapability('economic_prepare_employee_change', 'Prepare employee change', 'Create or update an employee in the Projects add-on (collection upsert).', 'draft', ['employee', 'write']),
  toolCapability('economic_prepare_time_entry', 'Prepare project time entry', 'Create or delete a project time registration (TimeEntries); requires project, activity and employee.', 'draft', ['project', 'time', 'hours', 'write']),
  toolCapability('economic_commit_prepared_operation', 'Commit prepared operation', 'Execute a prepared write operation only when write policy permits it.', 'commit', ['commit', 'audit']),
  toolCapability('economic_prepare_booking', 'Prepare booking of draft entries', 'Validate and prepare IRREVERSIBLE booking of explicit journal draft entries (guardrails: entries verified, amounts policy-checked, vouchers must have attachments).', 'dangerous', ['booking', 'bogføring', 'journal', 'write']),
  toolCapability('economic_prepare_open_item_match', 'Prepare open-item match', 'Prepare matching (udligning) of booked customer/supplier open items. No API undo exists.', 'dangerous', ['match', 'udligning', 'open items', 'write']),
  toolCapability('economic_commit_booking', 'Commit booking/match', 'Execute a prepared booking or open-item match. Requires the booking duty; irreversible.', 'dangerous', ['booking', 'commit', 'bogføring', 'udligning']),
  toolCapability('economic_call_endpoint', 'Call validated endpoint', 'Call an allowlisted REST/OpenAPI endpoint with schema and policy checks.', 'read', ['endpoint', 'escape-hatch']),
];

export const ENDPOINT_OPERATIONS: EndpointOperation[] = buildEndpointOperations();

export function findService(serviceId: string): EconomicService {
  const service = ECONOMIC_SERVICES.find(item => item.id === serviceId);
  if (!service) {
    throw new Error(`Unknown e-conomic service: ${serviceId}`);
  }

  return service;
}

/**
 * Only the OpenAPI surface registers a `/{resource}/paged` endpoint; the
 * classic REST surface paginates the plain collection path via
 * skippages/pagesize query params instead (a `/paged` path either 404s on
 * e-conomic's side or fails the local allowlist there).
 */
export function resolveReadPathTemplate(
  serviceId: string,
  resource: string,
  options: { number?: string | number; paged: boolean },
): string {
  if (options.number !== undefined) {
    return `/${resource}/{number}`;
  }

  const isPagedSurface = findService(serviceId).surface === 'openapi';
  return options.paged && isPagedSurface ? `/${resource}/paged` : `/${resource}`;
}

export function findEndpoint(
  serviceId: string,
  method: HttpMethod,
  pathTemplate: string,
): EndpointOperation {
  const endpoint = ENDPOINT_OPERATIONS.find(
    item =>
      item.serviceId === serviceId &&
      item.method === method &&
      normalizePathTemplate(item.pathTemplate) === normalizePathTemplate(pathTemplate),
  );

  if (!endpoint) {
    throw new Error(`Endpoint is not allowlisted: ${method} ${serviceId}:${pathTemplate}`);
  }

  return endpoint;
}

export function searchCapabilities(query: string, limit = 20): Capability[] {
  const normalized = query.trim().toLowerCase();
  const capabilities = [
    ...CURATED_CAPABILITIES,
    ...ENDPOINT_OPERATIONS.map(endpointToCapability),
    ...ECONOMIC_SERVICES.map(serviceToSchemaCapability),
  ];

  if (!normalized) {
    return capabilities.slice(0, limit);
  }

  return capabilities
    .map(capability => ({
      capability,
      score: scoreCapability(capability, normalized),
    }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || a.capability.id.localeCompare(b.capability.id))
    .slice(0, limit)
    .map(item => item.capability);
}

export function getCapability(id: string): Capability | undefined {
  return [
    ...CURATED_CAPABILITIES,
    ...ENDPOINT_OPERATIONS.map(endpointToCapability),
    ...ECONOMIC_SERVICES.map(serviceToSchemaCapability),
  ].find(capability => capability.id === id);
}

export function getSchemaSummary(serviceId: string, resource?: string): unknown {
  const service = findService(serviceId);
  const resources = resource ? service.resources.filter(item => item === resource) : service.resources;

  return {
    service: service.name,
    serviceId: service.id,
    surface: service.surface,
    version: service.version,
    resources,
    commonQuery: {
      filter: 'OpenAPI filter string where supported.',
      sort: 'Comma-separated field list where supported.',
      cursor: 'Cursor token for cursor pagination where supported.',
      pageSize: 'Page size for paged endpoints.',
      skippages: 'Classic REST pagination for REST endpoints.',
    },
    notes: [
      'Use economic_get_capability for endpoint-level detail.',
      'Use economic_validate_payload before preparing or committing writes.',
      'OpenAPI fields marked read-only by e-conomic must not be sent in write payloads.',
    ],
  };
}

function buildEndpointOperations(): EndpointOperation[] {
  const operations: EndpointOperation[] = [];

  for (const service of ECONOMIC_SERVICES) {
    for (const resource of service.resources) {
      if (service.surface === 'rest') {
        operations.push({
          id: endpointId(service.id, 'GET', `/${resource}`),
          serviceId: service.id,
          surface: service.surface,
          method: 'GET',
          pathTemplate: `/${resource}`,
          summary: `List REST ${resource}.`,
          risk: 'read',
        });
        operations.push({
          id: endpointId(service.id, 'GET', `/${resource}/{number}`),
          serviceId: service.id,
          surface: service.surface,
          method: 'GET',
          pathTemplate: `/${resource}/{number}`,
          summary: `Fetch one REST ${resource} resource.`,
          risk: 'read',
        });
        continue;
      }

      operations.push(
        {
          id: endpointId(service.id, 'GET', `/${resource}/paged`),
          serviceId: service.id,
          surface: service.surface,
          method: 'GET',
          pathTemplate: `/${resource}/paged`,
          summary: `Retrieve a page of ${resource}.`,
          risk: 'read',
        },
        {
          id: endpointId(service.id, 'GET', `/${resource}`),
          serviceId: service.id,
          surface: service.surface,
          method: 'GET',
          pathTemplate: `/${resource}`,
          summary: `Retrieve all ${resource}.`,
          risk: 'read',
        },
        {
          id: endpointId(service.id, 'GET', `/${resource}/count`),
          serviceId: service.id,
          surface: service.surface,
          method: 'GET',
          pathTemplate: `/${resource}/count`,
          summary: `Count ${resource}.`,
          risk: 'read',
        },
        {
          id: endpointId(service.id, 'GET', `/${resource}/{number}`),
          serviceId: service.id,
          surface: service.surface,
          method: 'GET',
          pathTemplate: `/${resource}/{number}`,
          summary: `Retrieve one ${resource} item.`,
          risk: 'read',
        },
        {
          id: endpointId(service.id, 'POST', `/${resource}`),
          serviceId: service.id,
          surface: service.surface,
          method: 'POST',
          pathTemplate: `/${resource}`,
          summary: `Create ${resource}.`,
          risk: 'commit',
        },
        {
          // e-conomic OpenAPI services upsert via the collection: PUT /{resource}
          // with the full object (including its key) creates or updates. Several
          // services (e.g. the Projects add-on) only support this collection PUT
          // and reject item-level PUT with HTTP 405.
          id: endpointId(service.id, 'PUT', `/${resource}`),
          serviceId: service.id,
          surface: service.surface,
          method: 'PUT',
          pathTemplate: `/${resource}`,
          summary: `Create or update ${resource} (collection upsert).`,
          risk: 'commit',
        },
        {
          id: endpointId(service.id, 'PUT', `/${resource}/{number}`),
          serviceId: service.id,
          surface: service.surface,
          method: 'PUT',
          pathTemplate: `/${resource}/{number}`,
          summary: `Update one ${resource} item.`,
          risk: 'commit',
        },
        {
          id: endpointId(service.id, 'DELETE', `/${resource}/{number}`),
          serviceId: service.id,
          surface: service.surface,
          method: 'DELETE',
          pathTemplate: `/${resource}/{number}`,
          summary: `Delete one ${resource} item.`,
          risk: 'dangerous',
        },
      );
    }
  }

  operations.push(
    customEndpoint('rest', 'POST', '/invoices/drafts', 'Create a draft (unbooked) sales invoice.', 'draft'),
    customEndpoint('rest', 'POST', '/accounts', 'Create a general ledger account.', 'commit'),
    customEndpoint('rest', 'PUT', '/accounts/{number}', 'Update a general ledger account.', 'commit'),
    // Customer/product master data writes on the classic REST surface: the
    // documented flow is create via POST and full-object update via item PUT
    // (read-merge-write).
    customEndpoint('rest', 'POST', '/customers', 'Create a customer.', 'commit'),
    customEndpoint('rest', 'PUT', '/customers/{number}', 'Update a customer (full object).', 'commit'),
    customEndpoint('rest', 'POST', '/products', 'Create a product.', 'commit'),
    customEndpoint('rest', 'PUT', '/products/{number}', 'Update a product (full object).', 'commit'),
    // Suppliers are classic REST master data (no OpenAPI supplier record).
    customEndpoint('rest', 'POST', '/suppliers', 'Create a supplier.', 'commit'),
    customEndpoint('rest', 'PUT', '/suppliers/{number}', 'Update a supplier (full object).', 'commit'),
    customEndpoint('journals', 'POST', '/journals/{number}/book', 'Book a journal.', 'dangerous'),
    customEndpoint('journals', 'POST', '/entries/draft/{journalNumber}/book', 'Book draft entries.', 'dangerous'),
    customEndpoint('journals', 'POST', '/journals/{journalNumber}/bookdraftentries', 'Book specific draft entries (irreversible).', 'dangerous'),
    customEndpoint('q2c', 'POST', '/invoices/drafts/{documentId}/lines/bulk', 'Bulk update draft invoice lines.', 'commit'),
    customEndpoint('documents', 'GET', '/AttachedDocuments/{number}/pdf', 'Fetch attached document PDF.', 'read'),
    customEndpoint('booked-entries', 'POST', '/booked-entries/match', 'Match booked entries.', 'dangerous'),
  );

  return operations;
}

function customEndpoint(
  serviceId: string,
  method: HttpMethod,
  pathTemplate: string,
  summary: string,
  risk: CapabilityRisk,
): EndpointOperation {
  const service = findService(serviceId);
  return {
    id: endpointId(serviceId, method, pathTemplate),
    serviceId,
    surface: service.surface,
    method,
    pathTemplate,
    summary,
    risk,
  };
}

function endpointToCapability(endpoint: EndpointOperation): Capability {
  return {
    id: endpoint.id,
    title: `${endpoint.method} ${endpoint.serviceId}:${endpoint.pathTemplate}`,
    kind: 'endpoint',
    description: endpoint.summary,
    risk: endpoint.risk,
    source: endpoint.serviceId,
    keywords: [endpoint.serviceId, endpoint.method.toLowerCase(), endpoint.pathTemplate],
  };
}

function serviceToSchemaCapability(service: EconomicService): Capability {
  return {
    id: `schema.${service.id}`,
    title: `${service.name} schema catalog`,
    kind: 'schema',
    description: `Inspect known resources for ${service.name}.`,
    risk: 'read',
    source: service.id,
    keywords: [service.id, service.name, ...service.resources],
  };
}

function toolCapability(
  id: string,
  title: string,
  description: string,
  risk: CapabilityRisk,
  keywords: string[],
): Capability {
  return {
    id,
    title,
    kind: 'tool',
    description,
    risk,
    source: 'mcp-server-e-conomic',
    keywords,
  };
}

function scoreCapability(capability: Capability, query: string): number {
  const haystack = [
    capability.id,
    capability.title,
    capability.description,
    capability.source,
    ...capability.keywords,
  ]
    .join(' ')
    .toLowerCase();

  return query
    .split(/\s+/)
    .filter(Boolean)
    .reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

function endpointId(serviceId: string, method: HttpMethod, pathTemplate: string): string {
  return `endpoint.${serviceId}.${method.toLowerCase()}.${normalizePathTemplate(pathTemplate)
    .replace(/^\//, '')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')}`;
}

function normalizePathTemplate(pathTemplate: string): string {
  return pathTemplate.startsWith('/') ? pathTemplate : `/${pathTemplate}`;
}
