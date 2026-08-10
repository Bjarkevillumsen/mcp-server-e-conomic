import { describe, expect, it } from 'vitest';
import {
  ENDPOINT_OPERATIONS,
  ECONOMIC_SERVICES,
  findEndpoint,
  getSchemaSummary,
  resolveReadPathTemplate,
  searchCapabilities,
} from '../src/economic/catalog.js';
import { materializePath } from '../src/economic/endpoints.js';

describe('e-conomic catalog', () => {
  it('lists current official API areas', () => {
    expect(ECONOMIC_SERVICES.map(service => service.id)).toEqual(
      expect.arrayContaining([
        'rest',
        'customers',
        'products',
        'accounts',
        'projects',
        'journals',
        'q2c',
        'suppliers',
        'subscriptions',
        'dimensions',
        'documents',
        'booked-entries',
        'accounting-years',
        'budgets',
        'webhooks',
      ]),
    );
  });

  it('searches curated tools and endpoint capabilities', () => {
    const results = searchCapabilities('customer');

    expect(results.some(result => result.id === 'economic_get_customer_overview')).toBe(true);
    expect(results.some(result => result.id.startsWith('endpoint.customers.'))).toBe(true);
  });

  it('allowlists and materializes endpoint templates', () => {
    const endpoint = findEndpoint('customers', 'GET', '/Customers/{number}');

    expect(endpoint.risk).toBe('read');
    expect(materializePath(endpoint, { number: 42 })).toBe('/Customers/42');
  });

  it('allowlists project add-on write endpoints', () => {
    const project = findEndpoint('projects', 'POST', '/Projects');
    expect(project.risk).toBe('commit');

    const projectGroup = findEndpoint('projects', 'POST', '/ProjectGroups');
    expect(projectGroup.serviceId).toBe('projects');

    const employee = findEndpoint('projects', 'POST', '/Employees');
    expect(employee.method).toBe('POST');

    const productGroup = findEndpoint('products', 'POST', '/productgroups');
    expect(productGroup.serviceId).toBe('products');
  });

  it('allowlists project add-on read-only and time-entry resources', () => {
    // Cost types and project statuses are read in the API (UI-managed).
    expect(findEndpoint('projects', 'GET', '/CostTypes').risk).toBe('read');
    expect(findEndpoint('projects', 'GET', '/ProjectStatuses').risk).toBe('read');
    // Activity groups and time entries are creatable via the API.
    expect(findEndpoint('projects', 'POST', '/ActivityGroups').method).toBe('POST');
    expect(findEndpoint('projects', 'POST', '/TimeEntries').method).toBe('POST');
  });

  it('allowlists collection-level PUT (e-conomic upsert pattern)', () => {
    // Projects upsert via PUT on the collection, not the item path.
    const upsert = findEndpoint('projects', 'PUT', '/Projects');
    expect(upsert.risk).toBe('commit');
    expect(materializePath(upsert, {})).toBe('/Projects');
  });

  it('summarizes schemas by service', () => {
    expect(getSchemaSummary('accounts')).toMatchObject({
      serviceId: 'accounts',
      resources: expect.arrayContaining(['Accounts']),
    });
  });

  it('contains a substantial endpoint coverage layer', () => {
    expect(ENDPOINT_OPERATIONS.length).toBeGreaterThan(100);
  });

  it('resolves the plain collection path for REST-surfaced services even when paged is requested', () => {
    // /suppliers/paged is not allowlisted for the REST surface — regression
    // for a curated read tool defaulting to a paged path that 404s/errors.
    expect(resolveReadPathTemplate('rest', 'suppliers', { paged: true })).toBe('/suppliers');
    expect(findEndpoint('rest', 'GET', resolveReadPathTemplate('rest', 'suppliers', { paged: true }))).toBeDefined();
  });

  it('resolves the /paged collection path for OpenAPI-surfaced services', () => {
    expect(resolveReadPathTemplate('projects', 'Projects', { paged: true })).toBe('/Projects/paged');
    expect(resolveReadPathTemplate('projects', 'Projects', { paged: false })).toBe('/Projects');
  });

  it('resolves the item path when a number is supplied, regardless of surface', () => {
    expect(resolveReadPathTemplate('rest', 'suppliers', { number: 42, paged: true })).toBe('/suppliers/{number}');
    expect(resolveReadPathTemplate('projects', 'Projects', { number: 42, paged: true })).toBe('/Projects/{number}');
  });
});
