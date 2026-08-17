import { describe, expect, it } from 'vitest';
import {
  compactDatasetResult,
  compileDatasetRead,
  compileEconomicFilter,
  getEconomicDataset,
  removeTechnicalMetadata,
} from '../src/stage1/datasets.js';

describe('Stage 1 validated datasets', () => {
  it('compiles supported structured filters into the e-conomic DSL', () => {
    const filter = compileEconomicFilter(getEconomicDataset('booked_entries'), [
      { field: 'supplierNumber', operator: 'eq', value: 42 },
      { field: 'date', operator: 'gte', value: '2023-01-01T00:00:00.000Z' },
      { field: 'date', operator: 'lte', value: '2023-12-31T23:59:59.999Z' },
    ]);
    expect(filter).toBe(
      'supplierNumber$eq:42$and:date$gte:2023-01-01T00:00:00.000Z$and:date$lte:2023-12-31T23:59:59.999Z',
    );
  });

  it('escapes filter control characters instead of allowing DSL injection', () => {
    const filter = compileEconomicFilter(getEconomicDataset('suppliers'), [
      { field: 'name', operator: 'like', value: 'A$(*,[])' },
    ]);
    expect(filter).toContain('name$like:*A$$');
    expect(filter).toContain('$(');
    expect(filter).toContain('$*');
    expect(filter).toContain('$,');
    expect(filter).toContain('$[');
    expect(filter).toContain('$]');
    expect(filter).toContain('$)');
  });

  it('rejects unknown fields, invalid operators, and wrong value types locally', () => {
    const dataset = getEconomicDataset('booked_entries');
    expect(() => compileEconomicFilter(dataset, [
      { field: 'madeUpField', operator: 'eq', value: 1 },
    ])).toThrow(/does not expose filter field/i);
    expect(() => compileEconomicFilter(dataset, [
      { field: 'supplierNumber', operator: 'like', value: '42' },
    ])).toThrow(/operator.*not valid/i);
    expect(() => compileEconomicFilter(dataset, [
      { field: 'supplierNumber', operator: 'eq', value: '42' },
    ])).toThrow(/expects a number/i);
  });

  it('maps a dataset enum to the fixed allowlisted service/resource pair', () => {
    expect(compileDatasetRead({
      dataset: 'suppliers',
      filters: [{ field: 'supplierNumber', operator: 'eq', value: 42 }],
    })).toMatchObject({
      serviceId: 'rest',
      resource: 'suppliers',
      filter: 'supplierNumber$eq:42',
    });
  });

  it('removes technical metadata recursively and reports explicit no_matches', () => {
    expect(removeTechnicalMetadata({
      self: 'noise',
      objectVersion: 'noise',
      metaData: { delete: 'noise' },
      nested: { deleteHref: 'kept-business-field', self: 'noise', name: 'Diverse udlæg' },
    })).toEqual({ nested: { deleteHref: 'kept-business-field', name: 'Diverse udlæg' } });

    expect(compactDatasetResult('booked_entries', {
      data: { items: [], pagination: { nextPage: 'noise' } },
      page: { pageSize: 100, maxRecords: 100, returnedRecords: 0, pagesFetched: 1, truncated: false },
    })).toMatchObject({ records: [], matchStatus: 'no_matches' });
  });
});
