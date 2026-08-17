import { describe, expect, it } from 'vitest';
import type { EconomicPolicy } from '../src/economic/policy.js';
import { checkStage1Policy } from '../src/stage1/policy.js';
import {
  assertSafeRelativePath,
  assertStage1CatalogRead,
} from '../src/stage1/read.js';

const policy: EconomicPolicy = {
  writesEnabled: true,
  bookingEnabled: false,
  allowedCapabilities: [
    'economic_create_sales_invoice_draft',
    'economic_create_journal_draft_entry',
  ],
  allowedServices: ['rest', 'journals'],
  allowedMethods: ['POST'],
  deniedPathPatterns: [
    '/invoices/booked',
    '/invoices/.*/send',
    '/journals/.*/book',
    '/entries/draft/.*/book',
    '/booked-entries/match',
    '/payment',
    '/webhooks',
  ],
};

const writeEnv = {
  ECONOMIC_ENABLE_WRITES: 'true',
  ECONOMIC_ENABLE_BOOKING: 'false',
} as NodeJS.ProcessEnv;

describe('Stage 1 catalog reads', () => {
  it.each([
    ['rest', '/customers'],
    ['rest', '/suppliers'],
    ['rest', '/products'],
    ['rest', '/accounts'],
    ['booked-entries', '/booked-entries/paged'],
    ['projects', '/Projects/paged'],
    ['rest', '/invoices/booked'],
  ])('allows cataloged GET %s:%s', (serviceId, path) => {
    expect(() => assertStage1CatalogRead(serviceId, path)).not.toThrow();
  });

  it.each([
    'https://evil.example/customers',
    '//evil.example/customers',
    'evil.example/customers',
    '/../customers',
    '/%2e%2e/customers',
    '/customers\\..\\secrets',
  ])('rejects unsafe path %s', path => {
    expect(() => assertSafeRelativePath(path)).toThrow();
  });

  it('rejects unknown paths, external hosts, and the webhook service', () => {
    expect(() => assertStage1CatalogRead('rest', '/not-in-catalog')).toThrow(/not allowlisted/);
    expect(() => assertStage1CatalogRead('rest', 'https://evil.example/customers')).toThrow();
    expect(() => assertStage1CatalogRead('webhooks', '/webhooks/paged')).toThrow(/forbidden/);
  });
});

describe('Stage 1 write policy', () => {
  it.each([
    ['economic_create_sales_invoice_draft', 'rest', '/invoices/drafts'],
    ['economic_create_journal_draft_entry', 'journals', '/draft-entries'],
  ])('allows only the approved POST capability %s', (capability, serviceId, path) => {
    expect(checkStage1Policy({
      capability,
      serviceId,
      method: 'POST',
      path,
      body: { amount: 100 },
    }, policy, writeEnv)).toMatchObject({ allowed: true });
  });

  it.each([
    ['book invoice', 'economic_create_sales_invoice_draft', 'rest', 'POST', '/invoices/booked'],
    ['send invoice', 'economic_create_sales_invoice_draft', 'rest', 'POST', '/invoices/drafts/1/send'],
    ['book journal', 'economic_create_journal_draft_entry', 'journals', 'POST', '/entries/draft/1/book'],
    ['payment', 'economic_prepare_payment_registration', 'journals', 'POST', '/draft-entries'],
    ['open-item matching', 'economic_prepare_open_item_match', 'booked-entries', 'POST', '/booked-entries/match'],
    ['delete', 'economic_create_sales_invoice_draft', 'rest', 'DELETE', '/invoices/drafts/1'],
    ['customer update', 'economic_prepare_customer_change', 'rest', 'POST', '/customers'],
    ['supplier update', 'economic_prepare_supplier_change', 'rest', 'POST', '/suppliers'],
    ['product update', 'economic_prepare_product_change', 'rest', 'POST', '/products'],
    ['account update', 'economic_prepare_account_change', 'rest', 'POST', '/accounts'],
    ['project update', 'economic_prepare_project_change', 'projects', 'POST', '/Projects'],
    ['employee update', 'economic_prepare_employee_change', 'projects', 'POST', '/Employees'],
    ['arbitrary POST', 'economic_call_endpoint', 'rest', 'POST', '/invoices/drafts'],
    ['arbitrary URL', 'economic_create_sales_invoice_draft', 'rest', 'POST', 'https://evil.example/'],
  ] as const)('denies %s', (_label, capability, serviceId, method, path) => {
    expect(checkStage1Policy({
      capability,
      serviceId,
      method,
      path,
    }, policy, writeEnv)).toMatchObject({ allowed: false });
  });

  it('requires the independent write flag and rejects booking-enabled configuration', () => {
    expect(checkStage1Policy({
      capability: 'economic_create_sales_invoice_draft',
      serviceId: 'rest',
      method: 'POST',
      path: '/invoices/drafts',
    }, policy, {})).toMatchObject({ allowed: false, reason: 'writes disabled' });

    expect(checkStage1Policy({
      capability: 'economic_create_sales_invoice_draft',
      serviceId: 'rest',
      method: 'POST',
      path: '/invoices/drafts',
    }, policy, { ...writeEnv, ECONOMIC_ENABLE_BOOKING: 'true' })).toMatchObject({
      allowed: false,
      reason: /booking enabled/,
    });
  });
});
