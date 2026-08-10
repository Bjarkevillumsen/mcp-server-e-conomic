import { EconomicHttpError } from '../errors.js';
import { normalizeJsonBody } from './json.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type QueryValue = string | number | boolean | null | undefined;
export type RawBody = Uint8Array | ArrayBuffer | string;

export interface EconomicClientOptions {
  appSecretToken?: string;
  agreementGrantToken?: string;
  restBaseUrl?: string;
  openApiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface EconomicRequestOptions {
  method?: HttpMethod;
  url?: string;
  path?: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  rawBody?: RawBody;
  rawContentType?: string;
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

export interface EconomicRawBodyOptions {
  method?: HttpMethod;
  query?: Record<string, QueryValue>;
  body: RawBody;
  contentType: string;
  headers?: Record<string, string>;
  idempotencyKey?: string;
}

export class EconomicClient {
  private readonly appSecretToken?: string;
  private readonly agreementGrantToken?: string;
  private readonly restBaseUrl: string;
  private readonly openApiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: EconomicClientOptions = {}) {
    this.appSecretToken = options.appSecretToken ?? process.env.ECONOMIC_APP_SECRET_TOKEN;
    this.agreementGrantToken =
      options.agreementGrantToken ?? process.env.ECONOMIC_AGREEMENT_GRANT_TOKEN;
    this.restBaseUrl = trimTrailingSlash(
      options.restBaseUrl ?? process.env.ECONOMIC_BASE_URL_REST ?? 'https://restapi.e-conomic.com',
    );
    this.openApiBaseUrl = trimTrailingSlash(
      options.openApiBaseUrl ??
        process.env.ECONOMIC_BASE_URL_OPENAPI ??
        'https://apis.e-conomic.com',
    );
    assertSafeBaseUrl(this.restBaseUrl, 'ECONOMIC_BASE_URL_REST');
    assertSafeBaseUrl(this.openApiBaseUrl, 'ECONOMIC_BASE_URL_OPENAPI');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.ECONOMIC_TIMEOUT_MS ?? 30_000);
  }

  async rest<T>(path: string, options: Omit<EconomicRequestOptions, 'path' | 'url'> = {}): Promise<T> {
    return this.request<T>({ ...options, path });
  }

  async restRawBody<T>(path: string, options: EconomicRawBodyOptions): Promise<T> {
    return this.request<T>({
      path,
      method: options.method ?? 'PUT',
      query: options.query,
      rawBody: options.body,
      rawContentType: options.contentType,
      headers: options.headers,
      idempotencyKey: options.idempotencyKey,
    });
  }

  async openApi<T>(
    servicePath: string,
    apiPath: string,
    options: Omit<EconomicRequestOptions, 'path' | 'url'> = {},
  ): Promise<T> {
    const service = servicePath.replace(/^\/+|\/+$/g, '');
    const path = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
    return this.request<T>({
      ...options,
      url: `${this.openApiBaseUrl}/${service}${path}`,
    });
  }

  async request<T>(options: EconomicRequestOptions): Promise<T> {
    this.assertConfigured();

    if (options.body !== undefined && options.rawBody !== undefined) {
      throw new Error('EconomicClient.request: pass either body (JSON) or rawBody, not both.');
    }

    const method = options.method ?? 'GET';
    const url = options.url ?? this.buildRestUrl(options.path ?? '/', options.query);
    const resolvedUrl = options.url ? appendQuery(url, options.query) : url;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-AppSecretToken': this.appSecretToken ?? '',
      'X-AgreementGrantToken': this.agreementGrantToken ?? '',
      ...options.headers,
    };

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
    } else if (options.rawBody !== undefined) {
      headers['Content-Type'] = options.rawContentType ?? 'application/octet-stream';
    }

    if (options.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey;
    }

    const fetchBody =
      options.rawBody !== undefined
        ? options.rawBody
        : options.body === undefined
          ? undefined
          : JSON.stringify(normalizeJsonBody(options.body));

    const response = await this.fetchImpl(resolvedUrl, {
      method,
      headers,
      body: fetchBody,
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    const body = await readResponseBody(response);

    if (!response.ok) {
      throw new EconomicHttpError({
        status: response.status,
        method,
        url: resolvedUrl,
        payload: body,
        retryAfter: response.headers.get('retry-after') ?? undefined,
        fallbackMessage: typeof body === 'string' ? body : undefined,
      });
    }

    return body as T;
  }

  buildRestUrl(path: string, query?: Record<string, QueryValue>): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return appendQuery(`${this.restBaseUrl}${normalizedPath}`, query);
  }

  private assertConfigured(): void {
    if (!this.appSecretToken || !this.agreementGrantToken) {
      throw new Error(
        'Missing e-conomic credentials. Set ECONOMIC_APP_SECRET_TOKEN and ECONOMIC_AGREEMENT_GRANT_TOKEN in the MCP server environment.',
      );
    }
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }

  const text = await response.text();

  if (!text) {
    return null;
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return text;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function appendQuery(urlValue: string, query?: Record<string, QueryValue>): string {
  const url = new URL(urlValue);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url.toString();
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function assertSafeBaseUrl(baseUrl: string, envName: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`${envName} is not a valid URL: ${baseUrl}`);
  }

  if (parsed.protocol === 'https:') {
    return;
  }

  if (parsed.protocol === 'http:' && isLocalHost(parsed.hostname)) {
    return;
  }

  throw new Error(
    `Refusing to send e-conomic credentials over ${parsed.protocol}//. Use https:// (loopback http:// is allowed for local mocks).`,
  );
}

function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}
