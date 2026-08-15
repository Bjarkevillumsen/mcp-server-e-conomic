import {
  ECONOMIC_SERVICES,
  findEndpoint,
  findService,
  resolveReadPathTemplate,
} from '../economic/catalog.js';
import type { EconomicClient, QueryValue } from '../economic/client.js';
import { callEndpoint } from '../economic/endpoints.js';

export const STAGE1_DEFAULT_PAGE_SIZE = 100;
export const STAGE1_MAX_PAGE_SIZE = 200;
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
    truncated: boolean;
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
  const query: Record<string, QueryValue> = {};
  if (input.filter) query.filter = input.filter;
  if (input.sort) query.sort = input.sort;
  if (input.cursor) query.cursor = input.cursor;

  const isCollectionRead =
    input.number === undefined &&
    !pathTemplate.includes('{') &&
    !/(?:\/count|\/pdf)$/i.test(pathTemplate);
  if (isCollectionRead) {
    if (service.surface === 'rest') {
      query.pagesize = effectivePageSize;
      query.skippages = clampInteger(input.page, 0, 0, 1_000_000);
    } else {
      query.pageSize = effectivePageSize;
    }
  }

  const pathParams =
    input.number === undefined
      ? input.pathParams
      : { ...(input.pathParams ?? {}), number: input.number };

  const response = await callEndpoint(client, {
    serviceId: input.serviceId,
    method: 'GET',
    pathTemplate,
    pathParams,
    query,
  });

  return boundReadResponse(response, effectivePageSize, maxRecords);
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

function boundReadResponse(
  response: unknown,
  pageSize: number,
  maxRecords: number,
): Stage1ReadResult {
  let data = response;
  let returnedRecords = isRecord(response) || Array.isArray(response) ? 1 : 0;
  let truncated = false;
  let nextCursor: string | undefined;

  if (Array.isArray(response)) {
    truncated = response.length > maxRecords;
    data = response.slice(0, maxRecords);
    returnedRecords = Math.min(response.length, maxRecords);
  } else if (isRecord(response)) {
    const collectionKey = Array.isArray(response.collection)
      ? 'collection'
      : Array.isArray(response.items)
        ? 'items'
        : undefined;

    if (collectionKey) {
      const collection = response[collectionKey] as unknown[];
      truncated = collection.length > maxRecords;
      returnedRecords = Math.min(collection.length, maxRecords);
      data = { ...response, [collectionKey]: collection.slice(0, maxRecords) };
    }

    if (typeof response.cursor === 'string' && response.cursor) {
      nextCursor = response.cursor;
    }
  }

  return {
    data,
    page: {
      pageSize,
      maxRecords,
      returnedRecords,
      truncated,
      ...(nextCursor ? { nextCursor } : {}),
    },
  };
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
