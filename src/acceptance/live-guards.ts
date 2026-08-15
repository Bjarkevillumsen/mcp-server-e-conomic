export const STAGE1_LIVE_EXPECTED_AGREEMENT = '1382005';
export const STAGE1_LIVE_TEST_REFERENCE = 'MCP-STAGE1-TEST';

export interface LiveAcceptanceGuardResult {
  expectedAgreementNumber: typeof STAGE1_LIVE_EXPECTED_AGREEMENT;
  writeAllowed: boolean;
}

/**
 * Fail-closed environment gate for manually initiated acceptance tests.
 * The subsequent /self validation is a separate, mandatory guard.
 */
export function validateLiveAcceptanceEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  options: { write: boolean },
): LiveAcceptanceGuardResult {
  if (environment.STAGE1_PROFILE !== 'true') {
    throw new Error('Live acceptance requires STAGE1_PROFILE=true.');
  }
  if (environment.ECONOMIC_ENABLE_BOOKING !== 'false') {
    throw new Error('Live acceptance requires ECONOMIC_ENABLE_BOOKING=false.');
  }
  if (environment.ECONOMIC_EXPECTED_AGREEMENT_NUMBER !== STAGE1_LIVE_EXPECTED_AGREEMENT) {
    throw new Error(`Live acceptance is locked to agreement ${STAGE1_LIVE_EXPECTED_AGREEMENT}.`);
  }
  if (!environment.ECONOMIC_APP_SECRET_TOKEN || !environment.ECONOMIC_AGREEMENT_GRANT_TOKEN) {
    throw new Error('Live acceptance requires e-conomic credentials in the process environment.');
  }

  if (options.write) {
    if (environment.ECONOMIC_ENABLE_WRITES !== 'true') {
      throw new Error('Live draft creation requires ECONOMIC_ENABLE_WRITES=true.');
    }
    if (environment.ECONOMIC_ALLOW_LIVE_WRITE_TESTS !== 'true') {
      throw new Error('Live draft creation requires ECONOMIC_ALLOW_LIVE_WRITE_TESTS=true.');
    }
  }

  return {
    expectedAgreementNumber: STAGE1_LIVE_EXPECTED_AGREEMENT,
    writeAllowed: options.write,
  };
}
