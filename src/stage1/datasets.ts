import type { Stage1ReadInput, Stage1ReadResult } from './read.js';

export const ECONOMIC_DATASET_IDS = [
  'accounts',
  'accounting_years',
  'attached_documents',
  'booked_entries',
  'budgets',
  'customers',
  'invoices_booked',
  'invoices_drafts',
  'invoices_overdue',
  'invoices_unpaid',
  'journal_drafts',
  'products',
  'projects',
  'suppliers',
  'time_entries',
] as const;

export type EconomicDatasetId = (typeof ECONOMIC_DATASET_IDS)[number];

export const ECONOMIC_FILTER_OPERATORS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'like',
  'in',
  'nin',
] as const;

export type EconomicFilterOperator = (typeof ECONOMIC_FILTER_OPERATORS)[number];
export type EconomicFilterScalar = string | number | boolean | null;

export interface EconomicStructuredFilter {
  field: string;
  operator: EconomicFilterOperator;
  value: EconomicFilterScalar | EconomicFilterScalar[];
}

export interface EconomicStructuredSort {
  field: string;
  direction?: 'asc' | 'desc';
}

export interface EconomicFilterFieldDefinition {
  description: string;
  type: 'string' | 'number' | 'boolean' | 'date-time';
  operators: readonly EconomicFilterOperator[];
  sortable?: boolean;
}

export interface EconomicDatasetDefinition {
  id: EconomicDatasetId;
  title: string;
  description: string;
  serviceId: string;
  resource: string;
  filterFields: Readonly<Record<string, EconomicFilterFieldDefinition>>;
  examples: readonly string[];
}

const comparable: readonly EconomicFilterOperator[] = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'];
const comparableList: readonly EconomicFilterOperator[] = [...comparable, 'in', 'nin'];
const textOperators: readonly EconomicFilterOperator[] = ['eq', 'ne', 'like', 'in', 'nin'];
const exactTextOperators: readonly EconomicFilterOperator[] = ['eq', 'ne', 'in', 'nin'];

export const ECONOMIC_DATASETS: Readonly<Record<EconomicDatasetId, EconomicDatasetDefinition>> = {
  accounts: dataset({
    id: 'accounts',
    title: 'Chart of accounts',
    description: 'General-ledger accounts and account metadata.',
    serviceId: 'accounts',
    resource: 'Accounts',
    filterFields: {
      number: field('Account number.', 'number', comparableList, true),
      name: field('Account name; string matching is case-insensitive.', 'string', textOperators),
      displayNumber: field('Display number used in e-conomic.', 'string', textOperators, true),
      currency: field('Three-letter account currency.', 'string', textOperators, true),
    },
    examples: ['number eq 1010', 'name like "bank"'],
  }),
  accounting_years: dataset({
    id: 'accounting_years',
    title: 'Accounting years',
    description: 'Configured accounting years.',
    serviceId: 'accounting-years',
    resource: 'AccountingYears',
    filterFields: {},
    examples: ['List the available accounting years without filters.'],
  }),
  attached_documents: dataset({
    id: 'attached_documents',
    title: 'Attached documents',
    description: 'Document metadata. Binary PDF data is not returned by this dataset.',
    serviceId: 'documents',
    resource: 'AttachedDocuments',
    filterFields: {},
    examples: ['List document metadata without filters.'],
  }),
  booked_entries: dataset({
    id: 'booked_entries',
    title: 'Booked accounting entries',
    description: 'Booked general-ledger, customer, and supplier entries.',
    serviceId: 'booked-entries',
    resource: 'booked-entries',
    filterFields: {
      accountNumber: field('General-ledger account number.', 'number', comparableList, true),
      entryNumber: field('Unique booked-entry number.', 'number', comparableList, true),
      amount: field('Amount in entry currency.', 'number', comparable, true),
      amountInBaseCurrency: field('Amount in agreement base currency.', 'number', comparable, true),
      currencyCode: field('Entry currency code.', 'string', exactTextOperators, true),
      customerInvoiceNumber: field('Booked customer invoice number.', 'number', comparableList),
      customerNumber: field('Customer number.', 'number', comparableList, true),
      date: field('Booking date/time in ISO format.', 'date-time', comparable, true),
      dueDate: field('Due date/time in ISO format.', 'date-time', comparable, true),
      projectNumber: field('Project number.', 'number', comparableList, true),
      remainder: field('Open remainder.', 'number', comparableList),
      supplierInvoiceNumber: field('Supplier invoice number.', 'string', exactTextOperators),
      supplierNumber: field('Supplier number.', 'number', comparableList),
      text: field('Entry text; like is case-insensitive.', 'string', [...comparable, 'like']),
      type: field('Entry type (3=supplier invoice, 4=supplier payment).', 'number', ['eq', 'ne'], true),
      vatAccountNumber: field('VAT account number.', 'string', exactTextOperators, true),
      voucherNumber: field('Voucher number.', 'number', comparableList),
    },
    examples: [
      'supplierNumber eq 42 AND date gte "2026-01-01" AND date lte "2026-12-31"',
      'text like "husleje"',
      'accountNumber in [1010, 1020, 1030]',
    ],
  }),
  budgets: dataset({
    id: 'budgets',
    title: 'Budget figures',
    description: 'Budget figures from the Budgets API.',
    serviceId: 'budgets',
    resource: 'budget-figures',
    filterFields: {},
    examples: ['List budget figures without filters.'],
  }),
  customers: dataset({
    id: 'customers',
    title: 'Customers',
    description: 'Customer master data.',
    serviceId: 'customers',
    resource: 'Customers',
    filterFields: {
      number: field('Customer number.', 'number', comparableList, true),
      name: field('Customer name; like is case-insensitive.', 'string', textOperators),
      corporateIdentificationNumber: field('CVR/business registration number.', 'string', textOperators),
    },
    examples: ['number eq 1001', 'name like "kunde"'],
  }),
  invoices_booked: restDataset(
    'invoices_booked',
    'Booked invoices',
    'Booked sales invoices.',
    'invoices/booked',
  ),
  invoices_drafts: restDataset(
    'invoices_drafts',
    'Draft invoices',
    'Unbooked sales invoice drafts.',
    'invoices/drafts',
  ),
  invoices_overdue: restDataset(
    'invoices_overdue',
    'Overdue invoices',
    'Booked sales invoices that are overdue.',
    'invoices/overdue',
  ),
  invoices_unpaid: restDataset(
    'invoices_unpaid',
    'Unpaid invoices',
    'Booked sales invoices with an outstanding amount.',
    'invoices/unpaid',
  ),
  journal_drafts: dataset({
    id: 'journal_drafts',
    title: 'Journal draft entries',
    description: 'Unbooked entries in e-conomic journals.',
    serviceId: 'journals',
    resource: 'draft-entries',
    filterFields: {
      entryTypeNumber: field('Entry type number.', 'number', comparableList, true),
      journalNumber: field('Journal number.', 'number', comparableList, true),
      accountNumber: field('Account number.', 'number', comparableList),
      contraAccountNumber: field('Contra account number.', 'number', comparableList),
      amount: field('Draft amount.', 'number', comparable, true),
      date: field('Draft date/time in ISO format.', 'date-time', comparable),
      text: field('Draft text; like is case-insensitive.', 'string', [...comparable, 'like']),
      supplierNumber: field('Supplier number.', 'number', comparableList),
    },
    examples: ['journalNumber eq 1', 'supplierNumber eq 42 AND date gte "2026-01-01"'],
  }),
  products: dataset({
    id: 'products',
    title: 'Products',
    description: 'Product master data.',
    serviceId: 'rest',
    resource: 'products',
    filterFields: {
      productNumber: field('Product number.', 'string', textOperators),
      name: field('Product name; like is case-insensitive.', 'string', textOperators),
      barred: field('Whether the product is barred.', 'boolean', ['eq', 'ne']),
    },
    examples: ['productNumber eq "A-100"', 'name like "service"'],
  }),
  projects: dataset({
    id: 'projects',
    title: 'Projects',
    description: 'Project master data.',
    serviceId: 'projects',
    resource: 'Projects',
    filterFields: {
      number: field('Project number.', 'number', comparableList, true),
      name: field('Project name; like is case-insensitive.', 'string', textOperators),
      closedDate: field('Project closing date/time in ISO format.', 'date-time', comparable),
    },
    examples: ['number eq 100', 'name like "renovering"'],
  }),
  suppliers: dataset({
    id: 'suppliers',
    title: 'Suppliers',
    description: 'Supplier master data from the classic REST API.',
    serviceId: 'rest',
    resource: 'suppliers',
    filterFields: {
      supplierNumber: field('Supplier number.', 'number', comparableList),
      name: field('Supplier name; like is case-insensitive.', 'string', textOperators),
      corporateIdentificationNumber: field('CVR/business registration number.', 'string', textOperators),
      email: field('Supplier email address.', 'string', textOperators),
      barred: field('Whether the supplier is barred.', 'boolean', ['eq', 'ne']),
    },
    examples: ['supplierNumber eq 42', 'name like "leverandør"'],
  }),
  time_entries: dataset({
    id: 'time_entries',
    title: 'Project time entries',
    description: 'Time registrations from the Projects API.',
    serviceId: 'projects',
    resource: 'TimeEntries',
    filterFields: {
      projectNumber: field('Project number.', 'number', comparableList),
      employeeNumber: field('Employee number.', 'number', comparableList),
      date: field('Registration date/time in ISO format.', 'date-time', comparable),
    },
    examples: ['projectNumber eq 100', 'date gte "2026-01-01"'],
  }),
};

export function getEconomicDataset(id: string): EconomicDatasetDefinition {
  const dataset = ECONOMIC_DATASETS[id as EconomicDatasetId];
  if (!dataset) {
    throw new Error(`Unknown dataset "${id}". Use economic_describe_data to list supported datasets.`);
  }
  return dataset;
}

export function compileDatasetRead(input: {
  dataset: EconomicDatasetId;
  recordNumber?: string | number;
  filters?: readonly EconomicStructuredFilter[];
  sort?: readonly EconomicStructuredSort[];
  page?: number;
  pageSize?: number;
  maxRecords?: number;
}): Stage1ReadInput {
  const dataset = getEconomicDataset(input.dataset);
  if (input.recordNumber !== undefined && (input.filters?.length || input.sort?.length)) {
    throw new Error('recordNumber cannot be combined with filters or sort.');
  }
  return {
    serviceId: dataset.serviceId,
    resource: dataset.resource,
    ...(input.recordNumber !== undefined ? { number: input.recordNumber } : {}),
    ...(input.filters?.length ? { filter: compileEconomicFilter(dataset, input.filters) } : {}),
    ...(input.sort?.length ? { sort: compileEconomicSort(dataset, input.sort) } : {}),
    ...(input.page !== undefined ? { page: input.page } : {}),
    ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
    ...(input.maxRecords !== undefined ? { maxRecords: input.maxRecords } : {}),
  };
}

export function compileEconomicFilter(
  dataset: EconomicDatasetDefinition,
  filters: readonly EconomicStructuredFilter[],
): string {
  if (filters.length < 1 || filters.length > 20) {
    throw new Error('A query must contain between 1 and 20 filters.');
  }
  return filters.map(filter => compileFilterPredicate(dataset, filter)).join('$and:');
}

export function compileEconomicSort(
  dataset: EconomicDatasetDefinition,
  sort: readonly EconomicStructuredSort[],
): string {
  if (sort.length < 1 || sort.length > 8) {
    throw new Error('A query must contain between 1 and 8 sort fields.');
  }
  const seen = new Set<string>();
  return sort.map(item => {
    const definition = dataset.filterFields[item.field];
    if (!definition) {
      throw new Error(`Dataset ${dataset.id} does not expose field "${item.field}". Use economic_describe_data.`);
    }
    if (!definition.sortable) {
      throw new Error(`Field "${item.field}" is not sortable for dataset ${dataset.id}.`);
    }
    if (seen.has(item.field)) throw new Error(`Sort field "${item.field}" was supplied more than once.`);
    seen.add(item.field);
    return `${item.direction === 'desc' ? '-' : ''}${item.field}`;
  }).join(',');
}

export function compactDatasetResult(datasetId: EconomicDatasetId, result: Stage1ReadResult): {
  dataset: EconomicDatasetId;
  records: unknown;
  page: Stage1ReadResult['page'];
  matchStatus: 'matched' | 'no_matches';
} {
  const normalized = collectionValue(result.data);
  const records = removeTechnicalMetadata(normalized);
  const count = Array.isArray(records) ? records.length : records === null || records === undefined ? 0 : 1;
  return {
    dataset: datasetId,
    records,
    page: result.page,
    matchStatus: count === 0 ? 'no_matches' : 'matched',
  };
}

export function removeTechnicalMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(removeTechnicalMetadata);
  if (!isRecord(value)) return value;
  const cleaned: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (isTechnicalKey(key)) continue;
    cleaned[key] = removeTechnicalMetadata(item);
  }
  return cleaned;
}

function compileFilterPredicate(
  dataset: EconomicDatasetDefinition,
  filter: EconomicStructuredFilter,
): string {
  const fieldDefinition = dataset.filterFields[filter.field];
  if (!fieldDefinition) {
    throw new Error(
      `Dataset ${dataset.id} does not expose filter field "${filter.field}". Use economic_describe_data for valid fields.`,
    );
  }
  if (!fieldDefinition.operators.includes(filter.operator)) {
    throw new Error(
      `Operator "${filter.operator}" is not valid for ${dataset.id}.${filter.field}; allowed: ${fieldDefinition.operators.join(', ')}.`,
    );
  }

  if (filter.operator === 'in' || filter.operator === 'nin') {
    if (!Array.isArray(filter.value) || filter.value.length < 1 || filter.value.length > 200) {
      throw new Error(`Operator "${filter.operator}" requires an array with 1-200 values.`);
    }
    return `${filter.field}$${filter.operator}:[${filter.value.map(value => encodeFilterScalar(fieldDefinition, value)).join(',')}]`;
  }
  if (Array.isArray(filter.value)) {
    throw new Error(`Operator "${filter.operator}" requires one scalar value, not an array.`);
  }
  if (filter.operator === 'like' && typeof filter.value !== 'string') {
    throw new Error('Operator "like" requires a string value.');
  }
  return `${filter.field}$${filter.operator}:${encodeFilterScalar(fieldDefinition, filter.value, filter.operator === 'like')}`;
}

function encodeFilterScalar(
  definition: EconomicFilterFieldDefinition,
  value: EconomicFilterScalar,
  contains = false,
): string {
  if (value === null) return '$null:';
  if (definition.type === 'number' && typeof value !== 'number') {
    throw new Error(`Filter field expects a number, received ${typeof value}.`);
  }
  if (definition.type === 'boolean' && typeof value !== 'boolean') {
    throw new Error(`Filter field expects a boolean, received ${typeof value}.`);
  }
  if ((definition.type === 'string' || definition.type === 'date-time') && typeof value !== 'string') {
    throw new Error(`Filter field expects a string, received ${typeof value}.`);
  }
  const encoded = typeof value === 'string' ? escapeEconomicFilterText(value) : String(value);
  return contains ? `*${encoded}*` : encoded;
}

function escapeEconomicFilterText(value: string): string {
  return value
    .replace(/\$/g, () => '$$')
    .replace(/\(/g, () => '$(')
    .replace(/\)/g, () => '$)')
    .replace(/\*/g, () => '$*')
    .replace(/,/g, () => '$,')
    .replace(/\[/g, () => '$[')
    .replace(/\]/g, () => '$]');
}

function collectionValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (Array.isArray(value.collection)) return value.collection;
  if (Array.isArray(value.items)) return value.items;
  return value;
}

function isTechnicalKey(key: string): boolean {
  return [
    'self',
    'metadata',
    'objectversion',
    'pagination',
    'firstpage',
    'lastpage',
    'nextpage',
    'previouspage',
    'delete-href',
  ].includes(key.toLowerCase());
}

function dataset(definition: EconomicDatasetDefinition): EconomicDatasetDefinition {
  return definition;
}

function restDataset(
  id: Extract<EconomicDatasetId, 'invoices_booked' | 'invoices_drafts' | 'invoices_overdue' | 'invoices_unpaid'>,
  title: string,
  description: string,
  resource: string,
): EconomicDatasetDefinition {
  return dataset({
    id,
    title,
    description,
    serviceId: 'rest',
    resource,
    filterFields: {},
    examples: ['List records without filters.'],
  });
}

function field(
  description: string,
  type: EconomicFilterFieldDefinition['type'],
  operators: readonly EconomicFilterOperator[],
  sortable = false,
): EconomicFilterFieldDefinition {
  return { description, type, operators, sortable };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
