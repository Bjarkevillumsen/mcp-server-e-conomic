import type { HttpMethod } from '../economic/client.js';
import {
  checkPolicy,
  loadPolicy,
  type EconomicPolicy,
  type PolicyCheckInput,
  type PolicyDecision,
} from '../economic/policy.js';

export const STAGE1_WRITE_OPERATIONS = {
  economic_create_sales_invoice_draft: {
    serviceId: 'rest',
    method: 'POST',
    path: '/invoices/drafts',
  },
  economic_create_journal_draft_entry: {
    serviceId: 'journals',
    method: 'POST',
    path: '/draft-entries',
  },
} as const;

/**
 * A hard-coded Stage 1 boundary layered on top of the upstream policy engine.
 * A permissive or malformed policy file cannot turn this into a generic write
 * capability.
 */
export function checkStage1Policy(
  input: PolicyCheckInput,
  policy: EconomicPolicy = loadPolicy(),
  environment: NodeJS.ProcessEnv = process.env,
): PolicyDecision {
  if (input.method === 'GET') {
    return checkPolicy(input, policy);
  }

  if (environment.ECONOMIC_ENABLE_WRITES !== 'true') {
    return { allowed: false, reason: 'writes disabled', policy };
  }

  if (environment.ECONOMIC_ENABLE_BOOKING === 'true' || policy.bookingEnabled) {
    return { allowed: false, reason: 'unsafe Stage 1 configuration: booking enabled', policy };
  }

  const operation = STAGE1_WRITE_OPERATIONS[input.capability as keyof typeof STAGE1_WRITE_OPERATIONS];
  if (!operation) {
    return { allowed: false, reason: `capability not allowed in Stage 1: ${input.capability}`, policy };
  }

  if (
    input.serviceId !== operation.serviceId ||
    input.method !== operation.method ||
    normalizePath(input.path) !== operation.path
  ) {
    return {
      allowed: false,
      reason: `Stage 1 capability used outside its exact draft endpoint: ${input.method} ${input.serviceId}:${input.path}`,
      policy,
    };
  }

  return checkPolicy(input, policy);
}

export function isStage1MutationAllowed(
  capability: string,
  serviceId: string,
  method: HttpMethod,
  path: string,
  body?: unknown,
): PolicyDecision {
  return checkStage1Policy({ capability, serviceId, method, path, body });
}

function normalizePath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}
