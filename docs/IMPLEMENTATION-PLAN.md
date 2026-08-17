# Stage 1 implementation plan

Work is delivered as four sequential, reviewable pull requests. Each later PR
is based on the prior PR and starts only after the prior branch passes its
required checks.

## PR 1 - upstream baseline

- Pin `borgels/mcp-server-e-conomic` commit
  `ee3feef4d9f8fcbcef92357e43f582bc311b34c7` (version `0.7.0`).
- Preserve the Apache-2.0 license and upstream attribution.
- Run the untouched install, typecheck, test, build, and production audit.
- Document scope, security assumptions, upstream reuse, inherited findings,
  and the staged implementation design.

Exit criteria: documentation-only diff; upstream tests remain green; inherited
audit findings are explicit.

## PR 2 - Stage 1 e-conomic functionality

- Add the Stage 1 server/profile and exact MCP tool allowlist.
- Wrap upstream reads under Stage 1 names.
- Add bounded, GET-only `stage1_read_economic` using the upstream catalog.
- Add direct draft invoice and journal-entry creation using the upstream client,
  prepared-operation validation, policy, and audit facilities.
- Add reusable agreement-number validation.
- Add a restrictive Stage 1 policy and exact-list/policy/draft tests.

Exit criteria: arbitrary URLs and all non-draft mutations fail before fetch;
the exact advertised list is asserted; typecheck/tests/build pass.

## PR 3 - Entra ID and application security

- Add tenant-specific OIDC discovery/JWKS signature verification with rotation.
- Implement protected-resource metadata, scope checks, Reader/DraftCreator RBAC,
  and per-invocation authorization.
- Harden HTTP parsing, timeouts, content type, CORS, request IDs, error handling,
  structured redacted logs, write audit, and production startup validation.
- Remediate inherited production dependency advisories.
- Add deterministic JWT/RBAC and HTTP/security tests.

Exit criteria: the required 401/403 matrix passes; secrets are redacted;
`npm audit --omit=dev`, typecheck, tests, and build pass.

## PR 4 - Windows production deployment

- Add WinSW service templates and idempotent install/update/rollback/uninstall,
  health, e-conomic, and Entra PowerShell scripts.
- Add a secrets-free environment example and restrictive Stage 1 policy.
- Add reproducible ZIP packaging and tagged-release CI.
- Complete Entra, network, Cloudflare Tunnel, reverse-proxy, architecture,
  threat-model, deployment, operations, and live-acceptance documentation.
- Add opt-in read/write acceptance tooling guarded by the exact agreement and
  live-write flags.

Exit criteria: the ZIP builds without secrets, contains required runtime and
service files, retains a rollback path, and the full non-live CI command set
passes.

## Multi-company extension

- Add a fail-closed, protected registry for 1-100 agreements with unique
  `companyId` and agreement number plus isolated token pairs.
- Add `stage1_list_companies`, require `companyId` everywhere else, and enforce
  per-company user-object ACLs after global Entra RBAC.
- Tag technical/audit events with company identity, verify each draft against
  the selected agreement, and provide a hidden-input Windows onboarding helper.
- Prove the 100-entry limit, cross-company credential isolation, ACL filtering,
  secret non-disclosure, and 101st-entry rejection with automated tests.

## Live acceptance boundary

Live tests are never automatic. No write runs unless all of these are true:

- `STAGE1_PROFILE=true`
- `ECONOMIC_ENABLE_BOOKING=false`
- `ECONOMIC_ALLOW_LIVE_WRITE_TESTS=true`
- configured expected agreement is `1382005`
- the e-conomic `/self` response also identifies agreement `1382005`

The two controlled write tests create exactly one clearly marked draft of each
approved type, read it back, and verify that it remains unbooked. Credentials
and full business payloads never enter the acceptance report.
