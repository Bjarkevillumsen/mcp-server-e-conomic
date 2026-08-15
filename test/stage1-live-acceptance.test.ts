import { describe, expect, it } from 'vitest';
import {
  STAGE1_LIVE_EXPECTED_AGREEMENT,
  validateLiveAcceptanceEnvironment,
} from '../src/acceptance/live-guards.js';

const safeBase = {
  STAGE1_PROFILE: 'true',
  ECONOMIC_ENABLE_BOOKING: 'false',
  ECONOMIC_ENABLE_WRITES: 'true',
  ECONOMIC_EXPECTED_AGREEMENT_NUMBER: STAGE1_LIVE_EXPECTED_AGREEMENT,
  ECONOMIC_APP_SECRET_TOKEN: 'fixture-app-token',
  ECONOMIC_AGREEMENT_GRANT_TOKEN: 'fixture-grant-token',
} as NodeJS.ProcessEnv;

describe('Stage 1 live acceptance guards', () => {
  it('allows guarded reads without enabling live writes', () => {
    expect(validateLiveAcceptanceEnvironment(safeBase, { write: false })).toEqual({
      expectedAgreementNumber: '1382005',
      writeAllowed: false,
    });
  });

  it('requires every write interlock', () => {
    expect(() => validateLiveAcceptanceEnvironment(safeBase, { write: true }))
      .toThrow(/ECONOMIC_ALLOW_LIVE_WRITE_TESTS=true/);
    expect(validateLiveAcceptanceEnvironment({
      ...safeBase,
      ECONOMIC_ALLOW_LIVE_WRITE_TESTS: 'true',
    }, { write: true })).toMatchObject({ writeAllowed: true });
  });

  it.each([
    ['wrong agreement', { ECONOMIC_EXPECTED_AGREEMENT_NUMBER: '9999999' }],
    ['booking enabled', { ECONOMIC_ENABLE_BOOKING: 'true' }],
    ['profile disabled', { STAGE1_PROFILE: 'false' }],
    ['missing app token', { ECONOMIC_APP_SECRET_TOKEN: '' }],
    ['missing grant token', { ECONOMIC_AGREEMENT_GRANT_TOKEN: '' }],
  ])('fails closed for %s', (_label, changes) => {
    expect(() => validateLiveAcceptanceEnvironment({ ...safeBase, ...changes }, { write: false })).toThrow();
  });
});
