# Upstream baseline

## Source

- Repository: `borgels/mcp-server-e-conomic`
- URL: <https://github.com/borgels/mcp-server-e-conomic>
- Version: `0.7.0`
- Pinned commit: `ee3feef4d9f8fcbcef92357e43f582bc311b34c7`
- Pin file: `UPSTREAM_COMMIT`
- License: Apache-2.0, preserved in `LICENSE`

The repository's original Borgels attribution is retained in `LICENSE` and
`NOTICE`. This customer profile is an independent derivative and does not imply
endorsement by Borgels, Visma, or e-conomic.

## Upstream components reused

Stage 1 builds on, rather than replaces, the upstream:

- `EconomicClient` REST/OpenAPI client and credential handling
- e-conomic service catalog and endpoint/path allowlisting
- schemas and curated read workflows
- prepared-operation hashing and validation
- server-side write policy and denied-path mechanisms
- JSONL audit writer and error redaction
- Streamable HTTP and stdio MCP transports
- Vitest test framework and mock-fetch patterns

## Local modification strategy

Customer behavior is isolated in Stage 1 profile, authentication, transport,
configuration, deployment, and documentation modules. The full upstream MCP
surface remains available in source for traceability but is not registered by
the Stage 1 production entrypoint. Changes to shared upstream files are kept
small and covered by regression tests.

## Baseline verification on 2026-08-15

- `npm ci`: passed (and ran the upstream prepare/build hook)
- `npm run typecheck`: passed
- `npm test`: passed, 7 files / 67 tests
- `npm run build`: passed
- `npm audit --omit=dev`: failed with 6 inherited production advisories

The audit findings are detailed in `docs/SECURITY-ASSUMPTIONS.md` and must be
resolved before release.

## Checking for updates

```powershell
git fetch upstream --tags
git log --oneline $(Get-Content .\UPSTREAM_COMMIT)..upstream/main
git diff $(Get-Content .\UPSTREAM_COMMIT)..upstream/main -- src test package.json package-lock.json
```

Review release notes, dependency changes, API-catalog additions, HTTP transport,
credential paths, policy semantics, audit behavior, and all write endpoints.
Never advance `UPSTREAM_COMMIT` only to obtain new features.

Before upgrading, rerun the exact Stage 1 tool-list assertion, the full denied
mutation/path/URL matrix, JWT/RBAC tests, redaction tests, startup validation,
`npm audit --omit=dev`, typecheck, unit tests, and build. Live reads may then be
run manually. Live writes require the separate opt-in gate and agreement-number
check and are not part of an upstream-update smoke test.
