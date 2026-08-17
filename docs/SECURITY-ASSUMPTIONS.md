# Stage 1 security assumptions

## Trust boundaries

- The Windows host is not domain joined and has no dependency on the customer
  LAN, Active Directory domain controllers, internal DNS, or a VPN.
- Internet traffic terminates at a managed HTTPS reverse proxy or Cloudflare
  Tunnel. The Node process is reachable only on `127.0.0.1`.
- Microsoft Entra ID is the sole application identity provider. Only one
  configured tenant is trusted.
- e-conomic credentials are protected registry secrets and never MCP inputs.
- e-conomic remains the system of record and its existing draft UI is the
  human approval boundary.

## Independent controls

Stage 1 relies on four independent authorization layers:

1. The MCP server registers only the exact `STAGE1_ALLOWED_TOOLS` list.
2. Every invocation validates a signed Entra token and maps its scope and app
   role to the requested tool.
3. The selected `companyId` must exist, be enabled, and permit the signed-in
   Entra user object ID for the requested read/draft access.
4. The e-conomic policy independently permits only the two named draft POST
   operations and denies booking, payment, sending, deletion, arbitrary writes,
   and master-data mutation.

Agreement validation is an additional write precondition. Before a live write,
the service reads `/self` (or the catalog equivalent) and requires the returned
agreement number to equal the selected registry entry. A mismatch fails before
an e-conomic mutation is sent.

## Fail-closed assumptions

Production startup is rejected if the Stage 1 profile, policy file, Entra
tenant/audience, 1-100 valid company entries, company credentials/ACLs, or
localhost bind is missing or unsafe. Duplicate IDs and agreement numbers are
rejected. `ECONOMIC_ENABLE_BOOKING=true` is always fatal. Token
verification fails closed when OIDC metadata or signing keys cannot be loaded.

JWT checks cover signature, issuer, tenant (`tid`), audience (`aud`), expiry,
not-before, delegated scope, and application roles. Keys come from Microsoft's
published tenant-specific metadata/JWKS endpoints and are cached with rotation
support. Claims are never trusted before signature verification.

## Data handling

Technical logs contain correlation and authorization metadata, operation
category, policy outcome, upstream status, duration, and safe draft identifiers.
They redact authorization headers, tokens, known secret field names, request
bodies, customer datasets, and binary documents. A separate append-only JSONL
trail records write attempts without full business payloads.

The health endpoint returns only `{ "status": "ok" }`.

## Inherited baseline findings and remediation

At pinned upstream commit `ee3feef4d9f8fcbcef92357e43f582bc311b34c7`,
`npm audit --omit=dev` reports six production dependency advisories: three high,
two moderate, and one low. The affected transitive packages include
`ip-address`, `fast-uri`, `hono`, `@hono/node-server`, `express-rate-limit`, and
`body-parser`. The untouched upstream typecheck, 67 tests, and build pass.

The Stage 1 dependency lock now pins remediated versions of the affected
transitive packages. After a clean install, `npm audit --omit=dev` reports zero
production vulnerabilities and the complete Stage 1 security suite passes.
These overrides are a small security deviation from the pinned baseline and
must be reviewed again whenever upstream dependencies are advanced. No live
credentials or writes are used in CI.

## Residual risks

- A compromised Windows administrator or service-account secret store can
  access runtime credentials; OS hardening and least privilege remain customer
  responsibilities.
- Availability depends on Microsoft OIDC/JWKS, Cloudflare (when selected), and
  e-conomic internet services.
- Customer subscriptions can make cataloged modules unavailable. This is an
  operational limitation, not permission to broaden the API surface.
- Cloudflare transport controls do not replace in-process Entra validation.
