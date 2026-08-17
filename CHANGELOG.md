# Changelog

## 0.7.0 (2026-07-15)

Conditional booking (booking duty) — booking stays denied by default:

- `economic_prepare_booking`: validate and prepare booking of EXPLICIT journal
  draft entries via journalsapi v15 `bookdraftentries`. Guardrails: entries
  must exist in the journal, per-entry amounts run the policy maxAmount
  check, and every referenced voucher must have an attached document.
- `economic_prepare_open_item_match`: prepare udligning of booked
  customer/supplier open items (no API undo exists).
- `economic_commit_booking`: the only executor for the two capabilities above;
  the ordinary commit tool rejects them (lets a gateway enforce a separate
  booking duty per tool name). Requires `ECONOMIC_ENABLE_BOOKING=true`.
- Journals service bumped to v15.0.0.

## 0.6.0 (2026-07-15)

- New `economic_prepare_supplier_change` tool (supplier master records via
  classic REST `/suppliers`).
- Default policy now denies `POST /invoices/booked` (classic REST invoice
  booking) — booking was already denied for journals; invoices are now
  consistently draft-only unless a custom policy explicitly allows booking.

## 0.5.1 (2026-07-14)

- `economic_get_company_context` (and the gateway `company_context` tool) now
  calls `GET /self` and returns the agreement's own context — company name,
  CVR, agreement number, modules, settings — instead of the anonymous REST
  root document. Use it to confirm which agreement the server is connected to.

## Unreleased

- Hardened the public Stage 1 HTTP surface with HSTS, nosniff/frame/referrer/
  permissions headers and a bounded, configurable per-client fixed-window rate
  limit that trusts forwarded client addresses only from the loopback proxy.
- Added an off-host GitHub Actions production monitor and a non-mutating Windows
  readiness check covering services, listeners, health, fail-closed settings,
  registry bounds, and optional protected backup freshness.
- Added an atomic semicolon-delimited CSV importer for bulk onboarding. It can
  reuse the protected App Secret Token from an existing company, validates every
  Agreement Grant Token against e-conomic before changing the complete 1-100
  company registry, defaults imports to read-only access, and rolls back if the
  service health check fails.
- Added a fail-closed multi-company Stage 1 registry for 1-100 e-conomic
  agreements, isolated credentials and expected agreement numbers per company,
  per-company user ACLs, `stage1_list_companies`, mandatory `companyId` on every
  business tool, company-tagged logs/audit, and a hidden-input Windows
  onboarding/rotation helper.
- Fixed Claude/Entra OAuth interoperability for remote MCP: protected-resource
  metadata and `WWW-Authenticate` now advertise the public HTTPS MCP resource
  and its fully qualified scope. Documented the required Entra v2 access-token
  manifest setting and added safe JWT failure-category diagnostics.

## 0.5.0

- Added `upsert_account` (risk `destructive`, disabled by default): create a
  general-ledger account via `POST /accounts`, or update by `accountNumber` via
  read-merge-write `PUT /accounts/{number}`. Editing the chart of accounts is a
  structural change, so a hosting control plane should gate it behind approval.
  Policy-gated; covered by live-path, negative-path, and contract-mode tests.

## 0.4.0

- Added supplier and project-employee write tools (risk `write`, disabled by
  default): `upsert_supplier` (classic REST: create `POST /suppliers`, update by
  `supplierNumber` via read-merge-write `PUT /suppliers/{number}`) and
  `upsert_employee` (Projects add-on collection upsert like `upsert_project`).
  Both policy-gated; covered by live-path, negative-path, and contract-mode tests.
- Allowlisted the classic REST supplier write endpoints (`POST /suppliers`,
  `PUT /suppliers/{number}`).

## 0.3.0

- Added gateway read tools for the newer OpenAPI services: `project_overview`
  (Projects add-on: Projects/ProjectGroups/CostTypes/Activities/Employees/
  TimeEntries via the `resource` param, default Projects) and `accounting_entries`
  (booked entries by default; journal draft entries via serviceId/resource). Both
  default OpenAPI-first (`apis.e-conomic.com`) and are enabled by default.
- Added project write tools (risk `write`, disabled by default): `upsert_project`
  (create via `POST /Projects`, update by `projectNumber` via read-merge-write
  collection `PUT /Projects` preserving `objectVersion`) and `create_time_entry`
  (register hours via `POST /TimeEntries`; create only). Both are policy-gated and
  covered by live-path, negative-path, and contract-mode tests.
- Generalized the gateway write-policy check to carry the OpenAPI `serviceId` so
  project writes are governed on the correct surface.

## 0.2.0

- Added an `enableWrites` gateway option (mirrors the Corpay One gateway): a
  hosting control plane that applies its own write governance opts in
  programmatically instead of via the standalone `ECONOMIC_ENABLE_WRITES` env
  flag. The rest of the write policy (denied paths, max amount) still applies.
- BREAKING: the `create_draft_invoice` gateway tool now enforces the write
  policy. Embedders must pass `enableWrites: true` (or set
  `ECONOMIC_ENABLE_WRITES=true`) for it to execute; previously it ran ungated.
- Added `upsert_customer` and `upsert_product` gateway tools (risk `write`,
  disabled by default). Customers create via `POST /customers` and update by
  `customerNumber` via read-merge-write `PUT /customers/{number}`; products use
  the `productNumber` key to decide create vs update. Both are policy-gated and
  covered by live-path, negative-path, and contract-mode tests.
- Allowlisted the REST customer/product write endpoints (`POST /customers`,
  `PUT /customers/{number}`, `POST /products`, `PUT /products/{number}`).

## 0.1.4

- Added Projects (Projektregnskab) add-on tools: `economic_prepare_project_change`,
  `economic_prepare_project_group_change`, `economic_prepare_employee_change`, and
  `economic_prepare_time_entry`. These model the e-conomic upsert pattern — create
  via `POST /X`, update via `PUT /X` (the full object including its number and
  `objectVersion`; a full replace), delete via `DELETE /X/{number}`. Item-level
  `PUT /X/{number}` and `PATCH` are unsupported by the API (HTTP 405).
- Allowlisted collection-level `PUT /{resource}` for OpenAPI services to reflect
  e-conomic's create-or-update-via-collection behavior, alongside the existing
  item-level operations.
- Added read coverage for project master data managed in the e-conomic UI:
  `CostTypes`, `ProjectStatuses`, `ActivityGroups` (plus `TimeEntries` and
  `Activities`) on the `projects` service.
- Added `economic_attach_sales_invoice_file` to upload a PDF/file attachment to a
  draft sales invoice via multipart `POST /invoices/drafts/{n}/attachment/file`.
- Added `POST /accounts` and `PUT /accounts/{number}` plus extra REST read
  resources (currencies, departments, employees, layouts, payment-terms, units,
  departmental-distributions); fixed the REST single-item GET path to `/{number}`.
- Added a `create_draft_invoice` gateway tool (risk `write`, disabled by default)
  that creates a draft (unbooked, unsent) sales invoice via
  `POST /invoices/drafts`. Currency, payment terms, VAT zone, recipient name, and
  layout default from the customer when not supplied; each line requires a product
  reference (an e-conomic validation requirement). Supports an idempotency key.
  Draft creation does not book or send anything. Covered by contract-mode and
  live-path gateway tests and exercised against a live demo agreement.

## 0.1.3

- Added `economic_attach_voucher_file` tool that uploads a binary attachment
  (typically a PDF) to an existing voucher in a daybook journal via
  `PUT /journals/{n}/vouchers/{ay}-{vn}/attachment/file`. Runs through the
  same policy and audit pipeline as other mutating tools and requires an
  idempotency key.
- Extended `EconomicClient` with `restRawBody()` and a `rawBody`/`rawContentType`
  pair on `request()` so non-JSON request bodies are first-class. `request()`
  now refuses to send a payload that sets both `body` and `rawBody`.

## 0.1.2

- Added Apache-2.0 `LICENSE` file and package metadata.
- Added `SECURITY.md` with the project security contact.
- Added GitHub Actions CI and Dependabot configuration.
- Hardened the Streamable HTTP transport with loopback default binding,
  optional bearer token, configurable CORS allowlist, 10 MiB default
  request-body cap, and explicit override for controlled deployments.
- Added package publish allowlist and `prepack` build guard.
- Refused non-HTTPS e-conomic base URLs except loopback mocks.
- Added transitive dependency overrides for MCP HTTP transport security alerts.
- Updated `zod`, `vitest`, and `@types/node` to current compatible releases.

## 0.1.1

- Added `npm run auth:grant` to capture an e-conomic Agreement Grant Token from
  the documented installation redirect flow.
- Documented the App Secret Token, App Public Token, and Agreement Grant Token
  setup path for users onboarding a real e-conomic agreement.
- Added `ECONOMIC_APP_PUBLIC_TOKEN` and `ECONOMIC_INSTALLATION_URL` examples for
  credential onboarding.

## 0.1.0

- Initial private e-conomic MCP server.
- Added read-first e-conomic client for REST and OpenAPI endpoints.
- Added capability discovery, schema summaries, and allowlisted endpoint calls.
- Added prepared-operation write flow with policy checks, idempotency, and audit logging.
