import { describe, expect, it, vi } from 'vitest';
import { EconomicClient } from '../src/economic/client.js';
import { EconomicHttpError, redactSecrets } from '../src/errors.js';

describe('EconomicClient', () => {
  it('sends e-conomic auth headers from environment-style options', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = new EconomicClient({
      appSecretToken: 'app-secret',
      agreementGrantToken: 'grant-token',
      restBaseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.rest('/customers', { query: { pagesize: 10 } });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('https://example.test/customers?pagesize=10');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      'X-AppSecretToken': 'app-secret',
      'X-AgreementGrantToken': 'grant-token',
      Accept: 'application/json',
    });
  });

  it('adds idempotency keys for mutating requests', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = new EconomicClient({
      appSecretToken: 'app-secret',
      agreementGrantToken: 'grant-token',
      restBaseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.rest('/customers', {
      method: 'POST',
      body: { name: 'Acme' },
      idempotencyKey: 'idem-12345',
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem-12345',
    });
    expect(init.body).toBe('{"name":"Acme"}');
  });

  it('redacts secrets in formatted errors', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ message: 'Nope' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new EconomicClient({
      appSecretToken: 'app-secret',
      agreementGrantToken: 'grant-token',
      restBaseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(client.rest('/customers')).rejects.toBeInstanceOf(EconomicHttpError);
    expect(redactSecrets('X-AppSecretToken: app-secret')).toContain('[REDACTED]');
  });

  it('refuses non-https base URLs to protect e-conomic credentials', () => {
    expect(
      () =>
        new EconomicClient({
          appSecretToken: 'app-secret',
          agreementGrantToken: 'grant-token',
          restBaseUrl: 'http://restapi.e-conomic.com',
          fetchImpl: vi.fn() as unknown as typeof fetch,
        }),
    ).toThrow(/https/);
  });

  it('sends raw binary bodies via restRawBody without JSON-encoding', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = new EconomicClient({
      appSecretToken: 'app-secret',
      agreementGrantToken: 'grant-token',
      restBaseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const payload = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    await client.restRawBody('/journals/1/vouchers/2026-7/attachment/file', {
      method: 'PUT',
      body: payload,
      contentType: 'application/pdf',
      idempotencyKey: 'idem-attach-1',
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://example.test/journals/1/vouchers/2026-7/attachment/file',
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('PUT');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/pdf',
      'Idempotency-Key': 'idem-attach-1',
    });
    expect(init.body).toBe(payload);
  });

  it('un-stringifies a JSON-string body instead of double-encoding it on the wire', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = new EconomicClient({
      appSecretToken: 'app-secret',
      agreementGrantToken: 'grant-token',
      restBaseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await client.rest('/products/1020', {
      method: 'PUT',
      body: '{"productNumber":"1020","name":"Widget"}',
      idempotencyKey: 'idem-12345',
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe('{"productNumber":"1020","name":"Widget"}');
  });

  it('rejects requests that combine JSON body and rawBody', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = new EconomicClient({
      appSecretToken: 'app-secret',
      agreementGrantToken: 'grant-token',
      restBaseUrl: 'https://example.test',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.request({
        path: '/anything',
        method: 'PUT',
        body: { a: 1 },
        rawBody: new Uint8Array([1, 2, 3]),
        rawContentType: 'application/pdf',
      }),
    ).rejects.toThrow(/body.*rawBody/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows http:// for loopback mocks', () => {
    expect(
      () =>
        new EconomicClient({
          appSecretToken: 'app-secret',
          agreementGrantToken: 'grant-token',
          restBaseUrl: 'http://localhost:8080',
          openApiBaseUrl: 'http://127.0.0.1:8081',
          fetchImpl: vi.fn() as unknown as typeof fetch,
        }),
    ).not.toThrow();
  });
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'content-type': 'application/json',
    },
  });
}
