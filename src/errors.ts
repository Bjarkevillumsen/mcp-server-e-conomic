const SECRET_PATTERNS = [
  /X-AppSecretToken:\s*[^,\s}]+/gi,
  /X-AgreementGrantToken:\s*[^,\s}]+/gi,
  /(appSecretToken|agreementGrantToken|ECONOMIC_APP_SECRET_TOKEN|ECONOMIC_AGREEMENT_GRANT_TOKEN|access[_-]?token|authorization)["']?\s*[:=]\s*["']?[^"',\s}]+/gi,
];

export interface EconomicErrorPayload {
  message?: string;
  error?: string;
  errors?: unknown[];
  logId?: string;
  [key: string]: unknown;
}

export class EconomicHttpError extends Error {
  readonly status: number;
  readonly method: string;
  readonly url: string;
  readonly payload?: EconomicErrorPayload | unknown;
  readonly retryAfter?: string;
  readonly logId?: string;

  constructor(input: {
    status: number;
    method: string;
    url: string;
    payload?: EconomicErrorPayload | unknown;
    retryAfter?: string;
    fallbackMessage?: string;
  }) {
    super(formatEconomicHttpError(input));
    this.name = 'EconomicHttpError';
    this.status = input.status;
    this.method = input.method;
    this.url = redactSecrets(input.url);
    this.payload = input.payload;
    this.retryAfter = input.retryAfter;
    this.logId = isEconomicErrorPayload(input.payload) ? input.payload.logId : undefined;
  }
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }

  return redactSecrets(String(error));
}

export function redactSecrets(value: string): string {
  const withoutBearerTokens = value.replace(
    /Bearer\s+[A-Za-z0-9._~+\/-]+/gi,
    'Bearer [REDACTED]',
  );
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, match => {
    const separator = match.includes(':') ? ':' : '=';
    const key = match.split(separator)[0]?.trim() ?? 'secret';
    return `${key}${separator} [REDACTED]`;
  }), withoutBearerTokens);
}

function formatEconomicHttpError(input: {
  status: number;
  method: string;
  url: string;
  payload?: EconomicErrorPayload | unknown;
  retryAfter?: string;
  fallbackMessage?: string;
}): string {
  const payload = isEconomicErrorPayload(input.payload) ? input.payload : undefined;
  const payloadErrors = Array.isArray(payload?.errors) ? JSON.stringify(payload.errors) : undefined;
  const parts = [
    `e-conomic API request failed with HTTP ${input.status}`,
    `${input.method.toUpperCase()} ${redactSecrets(input.url)}`,
    payload?.message,
    payload?.error,
    payloadErrors,
    payload?.logId ? `logId=${payload.logId}` : undefined,
    input.retryAfter ? `retry-after=${input.retryAfter}` : undefined,
    input.fallbackMessage,
  ].filter(Boolean);

  return redactSecrets(parts.join(' | '));
}

function isEconomicErrorPayload(value: unknown): value is EconomicErrorPayload {
  return typeof value === 'object' && value !== null;
}
