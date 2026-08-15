import { describe, expect, it, vi } from 'vitest';
import { EconomicClient } from '../src/economic/client.js';
import {
  extractAgreementNumber,
  validateExpectedAgreement,
} from '../src/stage1/agreement.js';

describe('Stage 1 agreement validation', () => {
  it('extracts supported agreement context shapes', () => {
    expect(extractAgreementNumber({ agreementNumber: 1382005 })).toBe('1382005');
    expect(extractAgreementNumber({ agreement: { number: '1382005' } })).toBe('1382005');
    expect(extractAgreementNumber({ agreement: { agreementNumber: 1382005 } })).toBe('1382005');
  });

  it('accepts the expected connected agreement', async () => {
    const fetchMock = vi.fn(async () => Response.json({ agreementNumber: 1382005 }));
    const client = new EconomicClient({
      appSecretToken: 'app',
      agreementGrantToken: 'grant',
      fetchImpl: fetchMock as typeof fetch,
    });

    await expect(validateExpectedAgreement(client, '1382005')).resolves.toMatchObject({
      agreementNumber: '1382005',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('fails closed for a mismatch or missing expected agreement', async () => {
    const client = new EconomicClient({
      appSecretToken: 'app',
      agreementGrantToken: 'grant',
      fetchImpl: async () => Response.json({ agreementNumber: 9999999 }),
    });

    await expect(validateExpectedAgreement(client, 1382005)).rejects.toThrow(/does not match/);
    await expect(validateExpectedAgreement(client, undefined)).rejects.toThrow(/required/);
  });
});
