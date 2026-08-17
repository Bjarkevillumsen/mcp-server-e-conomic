import {
  ECONOMIC_SERVICES,
  findEndpoint,
  findService,
  resolveReadPathTemplate,
} from '../economic/catalog.js';
import type { EconomicClient, QueryValue } from '../economic/client.js';
import { callEndpoint } from '../economic/endpoints.js';

export const STAGE1_DEFAULT_PAGE_SIZE = 100;
// e-conomic paged endpoints (including Booked Entries)
// accept at most 100 records. Keeping one truthful public limit prevents the
// model from wasting a request on a value that upstream will reject.
export const STAGE1_MAX_PAGE_SIZE = 100;
export const STAGE1_MAX_TOTAL_RECORDS = 500;

export const STAGE1_READ_SERVICE_IDS = ECONOMIC_SERVICES
  .map(service => service.id)
  .filter(serviceId => serviceId !== 'webhooks');

export interface Stage1ReadInput {
  serviceId: string;
  resource?: string;
  number?: string | number;
  pathTemplate?: string;
  pathParams?: Record<string, string | number>;
  filter?: string;
  sort?: string;
  cursor?: string;
  page?: number;
  pageSize?: number;
  maxRecords?: number;
}

export interface Stage1ReadResult {
  data: unknown;
  page: {
    pageSize: number;
    maxRecords: number;
    returnedRecords: number;
    pagesFetched: number;
    truncated: boolean;
    nextPage?: number;
    nextCursor?: string;
  };
}

export async function executeStage1Read(
  client: EconomicClient,
  input: Stage1ReadInput,
): Promise<Stage1ReadResult> {
  assertStage1Service(input.serviceId);
  const pageSize = clampInteger(input.pageSize, STAGE1_DEFAULT_PAGE_SIZE, 1, STAGE1_MAX_PAGE_SIZE);
  const maxRecords = clampInteger(input.maxRecords, pageSize, 1, STAGE1_MAX_TOTAL_RECORDS);
  const effectivePageSize = Math.min(pageSize, maxRecords);
  const pathTemplate = resolvePathTemplate(input);

  assertStage1CatalogRead(input.serviceId, pathTemplate);

  const service = findService(input.serviceId);
  const baseQuery: Record<string, QueryValue> = {};
  if (input.filter) baseQuery.filter = input.filter;
  if (input.sort) baseQuery.sort = input.sort;
  if (input.cursor) baseQuery.cursor = input.cursor;

  const isCollectionRead =
    input.number === undefined &&
    !pathTemplate.includes('{') &&
    !/(?:\/count|\/pdf)$/i.test(pathTemplate);
  const pathParams =
    input.number === undefined
      ? input.pathParams
      : { ...(input.pathParams ?? {}), number: input.number };

  if (!isCollectionRead) {
    const response = await callEndpoint(client, {
      serviceId: input.serviceId,
      method: 'GET',
      pathTemplate,
      pathParams,
      query: baseQuery,
    });
    return boundSingleResponse(response, effectivePageSize, maxRecords);
  }

  if (input.cursor) {
    throw new Error('Cursor paging is not accepted by the paged dataset tools. Use page/maxRecords; the server auto-pages safely.');
  }

  return readCollectionPages(client, {
    serviceId: input.serviceId,
    pathTemplate,
    pathParams,
    baseQuery,
    surface: service.surface,
    startPage: clampInteger(input.page, 0, 0, 100),
    pageSize: effectivePageSize,
    maxRecords,
  });
}

export function assertStage1CatalogRead(serviceId: string, pathTemplate: string): void {
  assertStage1Service(serviceId);
  assertSafeRelativePath(pathTemplate);
  findEndpoint(serviceId, 'GET', pathTemplate);
}

export function assertSafeRelativePath(pathTemplate: string): void {
  const normalized = pathTemplate.trim();
  if (!normalized.startsWith('/')) {
    throw new Error('Stage 1 reads require a relative catalog path beginning with /.');
  }

  if (
    normalized.startsWith('//') ||
    normalized.includes('://') ||
    normalized.includes('\\') ||
    /(^|\/)\.\.?($|\/)/.test(normalized) ||
    /%(?:2e|2f|5c)/i.test(normalized) ||
    normalized.includes('\0')
  ) {
    throw new Error('Unsafe or non-relative e-conomic path rejected.');
  }
}

function resolvePathTemplate(input: Stage1ReadInput): string {
  if (input.pathTemplate) {
    return input.pathTemplate;
  }

  if (!input.resource) {
    throw new Error('A catalog resource or pathTemplate is required.');
  }

  return resolveReadPathTemplate(input.serviceId, input.resource, {
    number: input.number,
    paged: input.number === undefined,
  });
}

function assertStage1Service(serviceId: string): void {
  if (!STAGE1_READ_SERVICE_IDS.includes(serviceId)) {
    throw new Error(`Unknown or forbidden Stage 1 e-conomic service: ${serviceId}`);
  }
}

function boundSingleResponse(
  response: unknown,
  pageSize: number,
  maxRecords: number,
): Stage1ReadResult {
  return {
    data: response,
    page: {
      pageSize,
      maxRecords,
      returnedRecords: response === null || response === undefined ? 0 : 1,
      pagesFetched: 1,
      truncated: false,
    },
  };
}

interface CollectionReadOptions {
  serviceId: string;
  pathTemplate: string;
  pathParams?: Record<string, string | number>;
  baseQuery: Record<string, QueryValue>;
  surface: 'rest' | 'openapi';
  startPage: number;
  pageSize: number;
  maxRecords: number;
}

async function readCollectionPages(
  client: EconomicClient,
  options: CollectionReadOptions,
): Promise<Stage1ReadResult> {
  const records: unknown[] = [];
  let firstResponse: unknown;
  let collectionKey: 'collection' | 'items' | undefined;
  let pagesFetched = 0;
  let hasMore = false;
  let nextCursor: string | undefined;

  const maximumPages = Math.min(
    Math.ceil(options.maxRecords / options.pageSize),
    101 - options.startPage,
  );
  for (let offset = 0; offset < maximumPages; offset += 1) {
    const pageNumber = options.startPage + offset;
    const query = { ...options.baseQuery };
    if (options.surface === 'rest') {
      query.pagesize = options.pageSize;
      query.skippages = pageNumber;
    } else {
      query.pageSize = options.pageSize;
      query.skipPages = pageNumber;
    }

    const response = await callEndpoint(client, {
      serviceId: options.serviceId,
      method: 'GET',
      pathTemplate: options.pathTemplate,
      pathParams: options.pathParams,
      query,
    });
    firstResponse ??= response;
    pagesFetched += 1;

    const page = extractCollectionPage(response);
    collectionKey ??= page.collectionKey;
    const remaining = options.maxRecords - records.length;
    records.push(...page.records.slice(0, remaining));
    nextCursor = page.nextCursor;

    const pageOverflowed = page.records.length > remaining;
    const pageWasFull = page.records.length >= options.pageSize;
    hasMore = pageOverflowed || pageWasFull || Boolean(page.nextCursor);
    if (pageOverflowed || records.length >= options.maxRecords || !pageWasFull) {
      break;
    }
  }

  const data = rebuildCollectionResponse(firstResponse, collectionKey, records);
  const truncated = records.length >= options.maxRecords && hasMore;
  const nextPage = truncated ? options.startPage + pagesFetched : undefined;

  return {
    data,
    page: {
      pageSize: options.pageSize,
      maxRecords: options.maxRecords,
      returnedRecords: records.length,
      pagesFetched,
      truncated,
      ...(nextPage !== undefined ? { nextPage } : {}),
      ...(nextCursor ? { nextCursor } : {}),
    },
  };
}

function extractCollectionPage(response: unknown): {
  records: unknown[];
  collectionKey?: 'collection' | 'items';
  nextCursor?: string;
} {
  if (Array.isArray(response)) {
    return { records: response };
  }
  if (!isRecord(response)) {
    throw new Error('e-conomic returned an unexpected non-collection response for a paged dataset.');
  }
  if (Array.isArray(response.collection)) {
    return {
      records: response.collection,
      collectionKey: 'collection',
      nextCursor: typeof response.cursor === 'string' && response.cursor ? response.cursor : undefined,
    };
  }
  if (Array.isArray(response.items)) {
    return {
      records: response.items,
      collectionKey: 'items',
      nextCursor: typeof response.cursor === 'string' && response.cursor ? response.cursor : undefined,
    };
  }
  throw new Error('e-conomic returned an object without a collection/items array for a paged dataset.');
}

function rebuildCollectionResponse(
  firstResponse: unknown,
  collectionKey: 'collection' | 'items' | undefined,
  records: unknown[],
): unknown {
  if (Array.isArray(firstResponse)) return records;
  if (isRecord(firstResponse) && collectionKey) {
    return { ...firstResponse, [collectionKey]: records };
  }
  return records;
}

function clampInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isInteger(value)) {
    return fallback;
  }

  return Math.min(Math.max(value, min), max);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
