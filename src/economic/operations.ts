import { createHash } from 'node:crypto';
import type { HttpMethod, QueryValue } from './client.js';
import { findEndpoint } from './catalog.js';
import { materializePath } from './endpoints.js';
import { normalizeJsonBody } from './json.js';
import { checkPolicy, type PolicyDecision } from './policy.js';

export interface PreparedOperation {
  capability: string;
  serviceId: string;
  method: HttpMethod;
  pathTemplate: string;
  pathParams?: Record<string, string | number>;
  query?: Record<string, QueryValue>;
  body?: unknown;
  dryRun: true;
  reason: string;
  operationHash: string;
  policyDecision: PolicyDecision;
}

export interface PrepareOperationInput {
  capability: string;
  serviceId: string;
  method: HttpMethod;
  pathTemplate: string;
  pathParams?: Record<string, string | number>;
  query?: Record<string, QueryValue>;
  body?: unknown;
  reason: string;
}

export function prepareOperation(input: PrepareOperationInput): PreparedOperation {
  const endpoint = findEndpoint(input.serviceId, input.method, input.pathTemplate);
  const path = materializePath(endpoint, input.pathParams);
  const body = normalizeJsonBody(input.body);
  const policyDecision = checkPolicy({
    capability: input.capability,
    serviceId: input.serviceId,
    method: input.method,
    path,
    body,
  });
  const operationBase = {
    capability: input.capability,
    serviceId: input.serviceId,
    method: input.method,
    pathTemplate: input.pathTemplate,
    pathParams: input.pathParams,
    query: input.query,
    body,
    reason: input.reason,
  };

  return {
    ...operationBase,
    dryRun: true,
    operationHash: stableHash(operationBase),
    policyDecision,
  };
}

/**
 * Verifies the operation hash and returns the operation with its body
 * normalized back to an object/array, in case the round trip through the
 * MCP client re-stringified it. Callers must use the returned operation
 * (not the input) for policy checks and dispatch.
 */
export function verifyPreparedOperation(operation: PreparedOperation): PreparedOperation {
  const body = normalizeJsonBody(operation.body);
  const expected = stableHash({
    capability: operation.capability,
    serviceId: operation.serviceId,
    method: operation.method,
    pathTemplate: operation.pathTemplate,
    pathParams: operation.pathParams,
    query: operation.query,
    body,
    reason: operation.reason,
  });

  if (expected !== operation.operationHash) {
    throw new Error('Prepared operation hash does not match the operation payload.');
  }

  return { ...operation, body };
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .filter(([, nested]) => nested !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}
