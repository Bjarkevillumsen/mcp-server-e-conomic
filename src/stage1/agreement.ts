import type { EconomicClient } from '../economic/client.js';

export interface AgreementValidationResult {
  agreementNumber: string;
  context: unknown;
}

/**
 * Reads the connected e-conomic context and fails before any mutation when it
 * does not identify the configured agreement. The agreement number is an
 * identity assertion only; it is never used as an API credential.
 */
export async function validateExpectedAgreement(
  client: EconomicClient,
  expectedValue: string | number | undefined = process.env.ECONOMIC_EXPECTED_AGREEMENT_NUMBER,
): Promise<AgreementValidationResult> {
  const expected = normalizeAgreementNumber(expectedValue);
  if (!expected) {
    throw new Error('ECONOMIC_EXPECTED_AGREEMENT_NUMBER is required before Stage 1 writes.');
  }

  const context = await client.rest<unknown>('/self');
  const actual = extractAgreementNumber(context);
  if (!actual) {
    throw new Error('Connected e-conomic context did not contain an agreement number; write aborted.');
  }

  if (actual !== expected) {
    throw new Error('Connected e-conomic agreement does not match the expected agreement; write aborted.');
  }

  return { agreementNumber: actual, context };
}

export function extractAgreementNumber(context: unknown): string | undefined {
  if (!isRecord(context)) {
    return undefined;
  }

  const direct = normalizeAgreementNumber(context.agreementNumber);
  if (direct) {
    return direct;
  }

  if (isRecord(context.agreement)) {
    return (
      normalizeAgreementNumber(context.agreement.agreementNumber) ??
      normalizeAgreementNumber(context.agreement.number)
    );
  }

  return undefined;
}

function normalizeAgreementNumber(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }

  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    return value.trim().replace(/^0+(?=\d)/, '');
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
