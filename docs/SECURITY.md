# Security controls

## Enforced boundary

Stage 1 exposes 13 catalog-bounded read tools and exactly two draft mutations.
It does not expose the upstream generic write/commit/booking tools. The generic
Stage 1 reader has no method or URL input, accepts only known e-conomic catalog
paths, rejects traversal/hosts/schemes/webhooks, and caps a response at 500
records.

Three independent controls enforce the write boundary: exact MCP registration,
per-call Entra RBAC, and a hard-coded Stage 1 operation map layered over the
upstream policy. The policy file cannot broaden the hard-coded map. Booking
enabled at runtime or in policy causes denial; production startup rejects
`ECONOMIC_ENABLE_BOOKING=true`.

## Identity and HTTP

- One tenant only; tenant GUID, issuer, audience, signature, RS256 algorithm,
  expiry, not-before, scope, and roles are verified.
- OIDC/JWKS failures fail closed. Keys are remotely cached with rotation support.
- Missing/invalid authentication returns 401; valid tokens lacking permission
  return 403 before MCP dispatch. Tool callbacks repeat authorization.
- Production binds to `127.0.0.1`; configured public origins must be clean HTTPS
  origins. JSON content type, body size, request/header timeouts, request shape,
  and CORS are enforced.
- Error responses are generic and contain no stack trace. `/healthz` returns only
  `{ "status": "ok" }`.

## Secrets and logs

Secrets come from `C:\ProgramData\EconomicMcp\config\stage1.env`, whose ACL is
limited to SYSTEM, administrators, and read access for the dedicated virtual
service account. They are never MCP inputs or committed files. Production
rejects alternate e-conomic hosts so credentials cannot be redirected.

Technical JSON logs redact bearer tokens, authorization headers, named token
fields, and e-conomic credentials. They do not log request bodies, full customer
or accounting datasets, or binary documents. The write audit contains identity,
tool/action, policy result, agreement number, safe draft identifier/reference,
and outcome; idempotency keys are hashed.

Protect logs and audit records according to accounting/security retention rules.
Forward them to a controlled collector if required, preserving JSON and access
controls. Never grant the service account write access outside its log and audit
directories.

## Dependency and release integrity

CI runs clean install, typecheck, 147+ unit/security tests, build, and production
dependency audit. Release packaging re-runs the checks, installs production-only
dependencies, verifies the pinned WinSW 2.12.0 SHA-256, and records per-file
hashes in `release-manifest.json`. Tagged releases are immutable inputs to the
Windows change process. Verify the GitHub release and manifest before deployment.

## Incident actions

If any token may be exposed: stop EconomicMcp, revoke/rotate the e-conomic app or
agreement token as applicable, rotate the Cloudflare tunnel token when affected,
revoke Entra sessions/assignments as applicable, inspect redacted technical and
write-audit logs, redeploy from a trusted release, and retest all boundaries.
Do not delete audit evidence during response.
