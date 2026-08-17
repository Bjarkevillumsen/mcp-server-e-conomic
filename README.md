# mcp-server-e-conomic

TypeScript MCP server for Visma e-conomic APIs. It is intentionally boring good:
typed, documented, read-first, policy-aware, credential-sane, and audit-friendly.

> **Disclaimer:** This is an independent, unofficial project by Borgels. Borgels is
> not affiliated with, endorsed by, or supported by Visma, Visma e-conomic, or
> e-conomic. "Visma", "e-conomic", and the e-conomic APIs are referenced only to
> describe what this server talks to. You need your own e-conomic credentials, and
> use of the e-conomic APIs is subject to Visma/e-conomic's own terms.

## Customer Stage 1 profile

This fork adds a production-hardened, localhost-only Stage 1 profile for an
isolated Windows Server. It advertises bounded reads plus exactly two unbooked
draft writes, validates single-tenant Microsoft Entra tokens and roles, and is
able to isolate up to 100 e-conomic agreements behind one MCP connector. Every
Stage 1 business tool requires a `companyId` returned by
`economic_list_companies`; each company has its own protected credential pair and
optional Entra user-object ACL. It is
packaged for WinSW and either Cloudflare Tunnel or the checksum-pinned Caddy
HTTPS reverse proxy. Start with
[`docs/STAGE1-SCOPE.md`](docs/STAGE1-SCOPE.md),
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and
[`docs/WINDOWS-DEPLOYMENT.md`](docs/WINDOWS-DEPLOYMENT.md).

The Stage 1 production entry point is `economic-mcp-stage1`. The upstream server
remains in source for attribution and reuse, but is not the production profile.

The production profile advertises seven task-oriented tools: company listing and
context, dataset discovery, validated querying, cross-company supplier
transactions, and the two unbooked draft creators. The query surface uses a
dataset enum and structured filters; it does not expose raw resource names,
URLs, or filter strings to the AI client.

## Scope

The server exposes e-conomic through three layers:

- Curated MCP tools for common accounting workflows.
- Discovery tools so MCP clients can find supported resources and endpoint shapes.
- A validated endpoint caller for long-tail coverage, allowlisted against the
  known e-conomic API catalog.

Default install mode is read-only. Writes require explicit environment opt-in,
policy approval, a prepared operation hash, a reason, and an idempotency key.

## Setup

Install dependencies and build the CLI:

```sh
npm install
npm run build
```

Set e-conomic credentials in the MCP server environment. The server sends these
as e-conomic's documented headers and never accepts credentials as tool
arguments.

```sh
export ECONOMIC_APP_SECRET_TOKEN="your-app-secret-token"
export ECONOMIC_AGREEMENT_GRANT_TOKEN="your-agreement-grant-token"
```

### Getting Real Credentials

e-conomic's token model has three names that are easy to mix up:

- App Secret Token: a private token for your app. This becomes
  `ECONOMIC_APP_SECRET_TOKEN` and is sent as `X-AppSecretToken`.
- App Public Token: a public app identifier used to create the Installation URL.
  It is not sent by this MCP server on API requests.
- Agreement Grant Token: created when an accounting agreement user grants your
  app access. This becomes `ECONOMIC_AGREEMENT_GRANT_TOKEN` and is sent as
  `X-AgreementGrantToken`.

Create the app-side tokens first:

1. Create or sign in to an e-conomic developer agreement.
2. Open the developer area's Apps tab.
3. Create a new app and select the roles/scopes your integration needs.
4. Save the app and copy the App Secret Token and App Public Token.
5. Store the App Secret Token in a password manager or secret store. Treat it as
   a real secret; reset it in e-conomic if it is lost or exposed.

Then create the agreement-side token:

1. Use the app's Installation URL, or build one from the App Public Token:

   ```text
   https://secure.e-conomic.com/secure/api1/requestaccess.aspx?appPublicToken=YOUR_APP_PUBLIC_TOKEN
   ```

2. Open that URL while logged into the e-conomic agreement that should grant
   access.
3. Approve adding the app.
4. Copy the shown Agreement Grant Token, or configure a redirect URL and let the
   helper below capture it.

If your e-conomic app is configured with a redirect URL, this repository includes
a local callback helper that can capture the Agreement Grant Token after the user
approves access:

```sh
export ECONOMIC_APP_PUBLIC_TOKEN="your-app-public-token"
npm run auth:grant
```

You can also pass the full Installation URL instead:

```sh
export ECONOMIC_INSTALLATION_URL="https://secure.e-conomic.com/secure/api1/requestaccess.aspx?appPublicToken=..."
npm run auth:grant
```

The helper prints a local callback URL such as:

```text
http://127.0.0.1:3333/economic/grant/callback
```

Configure that URL as the app installation redirect URL in e-conomic if your
agreement/app setup allows local redirects. For shared or production onboarding,
use the same redirect flow with a small HTTPS endpoint you control. After the
logged-in user approves access, e-conomic redirects back with `?token=...`; the
helper prints the matching `ECONOMIC_AGREEMENT_GRANT_TOKEN` export line. Treat
both tokens as secrets.

For GET-only demo mode, e-conomic documents that both tokens can be set to
`demo`:

```sh
export ECONOMIC_APP_SECRET_TOKEN="demo"
export ECONOMIC_AGREEMENT_GRANT_TOKEN="demo"
```

## Claude Or Cursor Config

Use the stdio server for local MCP clients:

```json
{
  "mcpServers": {
    "e-conomic": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-e-conomic/dist/stdio.js"],
      "env": {
        "ECONOMIC_APP_SECRET_TOKEN": "your-app-secret-token",
        "ECONOMIC_AGREEMENT_GRANT_TOKEN": "your-agreement-grant-token"
      }
    }
  }
}
```

During development:

```json
{
  "mcpServers": {
    "e-conomic": {
      "command": "npm",
      "args": ["run", "dev", "--prefix", "/absolute/path/to/mcp-server-e-conomic"],
      "env": {
        "ECONOMIC_APP_SECRET_TOKEN": "demo",
        "ECONOMIC_AGREEMENT_GRANT_TOKEN": "demo"
      }
    }
  }
}
```

## Start Here

Ask the MCP client to call:

- `economic_search_capabilities` to find tools, schemas, and endpoint operations.
- `economic_get_capability` to inspect one capability before calling it.
- `economic_get_schema` to inspect known resources for an API area.
- `economic_check_connection` to verify credentials.

## Main Tools

Discovery:

- `economic_search_capabilities`
- `economic_get_capability`
- `economic_get_schema`

Read tools:

- `economic_check_connection`
- `economic_get_company_context`
- `economic_search_entities`
- `economic_get_entity`
- `economic_get_customer_overview`
- `economic_get_supplier_overview`
- `economic_get_product_overview`
- `economic_get_sales_document`
- `economic_get_accounting_entries`
- `economic_get_project_overview`
- `economic_get_document`
- `economic_get_report`
- `economic_reconcile_open_items`
- `economic_validate_payload`

Write preparation and commit:

- `economic_prepare_customer_change`
- `economic_prepare_product_change`
- `economic_prepare_product_group_change`
- `economic_prepare_sales_document`
- `economic_prepare_journal_entry`
- `economic_prepare_payment_registration`
- `economic_prepare_project_change`
- `economic_prepare_project_group_change`
- `economic_prepare_employee_change`
- `economic_prepare_time_entry`
- `economic_commit_prepared_operation`
- `economic_attach_voucher_file`
- `economic_attach_sales_invoice_file`

The project tools target the e-conomic Projects (Projektregnskab) add-on. Projects
collect per-job revenue and cost, project groups route project registrations to
accounts, and employees provide the responsible person required on a project.
`economic_prepare_time_entry` registers hours against a project/activity/employee.
The Projects add-on upserts via the collection: create with `POST /X`, update with
`PUT /X` (the full object including its number and `objectVersion`), delete with
`DELETE /X/{number}`. Item-level `PUT /X/{number}` and `PATCH` return HTTP 405, and
a `PUT` is a full replace (omitted fields are cleared). Project status, cost types
and activities are read-only via the API and managed in the e-conomic UI; time
entries support create and delete only.

Long-tail coverage:

- `economic_call_endpoint`

`economic_call_endpoint` is not arbitrary HTTP. It only calls allowlisted
e-conomic API operations and is read-only unless write policy permits the call.

## Write Policy

Writes are blocked unless explicitly enabled:

```sh
export ECONOMIC_ENABLE_WRITES=true
export ECONOMIC_POLICY_PATH="/absolute/path/to/economic-policy.json"
export ECONOMIC_AUDIT_LOG="/absolute/path/to/economic-audit.jsonl"
```

Example policy:

```json
{
  "writesEnabled": true,
  "allowedCapabilities": [
    "economic_prepare_customer_change",
    "economic_prepare_product_change"
  ],
  "allowedServices": ["customers", "products"],
  "allowedMethods": ["POST", "PUT"],
  "deniedPathPatterns": [
    "/journals/.*/book",
    "/entries/draft/.*/book",
    "/booked-entries/match",
    "/webhooks",
    "/vat",
    "/payment"
  ],
  "maxAmount": 10000
}
```

Write flow:

1. Call a `economic_prepare_*` tool with a business reason.
2. Inspect the returned dry-run payload and `operationHash`.
3. Call `economic_commit_prepared_operation` with the full prepared operation,
   matching `confirmOperationHash`, and an `idempotencyKey`.

## Security And Audit

If `ECONOMIC_AUDIT_LOG` is set, every mutating attempt writes a JSONL record with
timestamp, request id, tool, service, method/path, operation hash, policy
decision, idempotency-key hash, status, and redacted errors. Secrets are never
logged intentionally.

Credentials are read only from the MCP server environment and are never accepted
as tool arguments. Report suspected vulnerabilities privately to
<security@borgels.com>. Do not include API tokens, accounting data, or other
secrets in public GitHub issues.

## Optional HTTP Server

The local stdio transport is the default. A small Streamable HTTP entrypoint is
available:

```sh
PORT=3000 ECONOMIC_APP_SECRET_TOKEN="demo" ECONOMIC_AGREEMENT_GRANT_TOKEN="demo" npm run dev:http
```

By default the HTTP server binds to `127.0.0.1`, limits request bodies to 10 MiB,
allows browser CORS only from loopback origins, and does not require an HTTP
Bearer token. You can override this with `MCP_HTTP_HOST`, `MCP_MAX_BODY_BYTES`,
`MCP_ALLOWED_ORIGINS`, `MCP_ALLOW_ANY_ORIGIN=true`, and `MCP_HTTP_TOKEN`.

The MCP endpoint is `POST http://127.0.0.1:3000/mcp`.

## Borgels Gateway Contract

`mcp-server-e-conomic/gateway` is the supported package export for Borgels
control-plane runtimes that need to wrap e-conomic without copying connector
logic.

The gateway exports:

- `economicGatewayTools`: stable unprefixed tool definitions with name, title,
  description, risk level, default enablement, and JSON input schema.
- `createEconomicGateway(options)`: a factory that accepts e-conomic credentials,
  optional base URLs, timeout, optional `fetchImpl`, optional contract mode, and
  optional `enableWrites`.

Read gateway tools:

- `check_connection`
- `company_context`
- `search_entities`
- `get_entity`
- `customer_overview`
- `supplier_overview`
- `product_overview`
- `report_data`
- `invoice_overview`

Write gateway tools (risk `write`, disabled by default, policy-gated):

- `create_draft_invoice` — draft (unbooked, unsent) sales invoice
- `upsert_customer` — create, or read-merge-write update by `customerNumber`
- `upsert_product` — create or update keyed on `productNumber`

Write tools execute only when the embedder passes `enableWrites: true` (for
control planes that apply their own write governance: scopes, approvals, audit)
or the standalone `ECONOMIC_ENABLE_WRITES` env flag is set. The rest of the
write policy (denied paths, max amount) still applies on top. Booking, sending,
payments, and deletes are not exposed through the gateway; the generic prepare
and commit tools remain available only on the full MCP server surface.

The gateway reads credentials from the server environment or factory options,
never from tool arguments. Upstream HTTP failures use the same formatted,
redacted error path as the full MCP server.

For review automation without live e-conomic credentials, set
`contractMode: true` when creating the gateway:

```ts
import { createEconomicGateway } from 'mcp-server-e-conomic/gateway';

const gateway = createEconomicGateway({ contractMode: true });
const result = await gateway.callTool('customer_overview', { number: 1001 });
```

Contract mode is deterministic, performs no network calls, and returns fixture
customers, products, accounts, company context, and pagination metadata. It is
intended for Borgels review/demo tests only; production connectors should use
real e-conomic credentials or e-conomic's documented `demo` tokens for live
GET-only smoke tests.

## Verification

Run checks without real credentials:

```sh
npm run typecheck
npm test
npm run build
```

Run the optional live GET smoke test with demo or real credentials:

```sh
ECONOMIC_APP_SECRET_TOKEN="demo" ECONOMIC_AGREEMENT_GRANT_TOKEN="demo" npm run smoke:live
```

## API Sources

- REST docs: <https://restdocs.e-conomic.com/>
- OpenAPI docs: <https://apis.e-conomic.com/>
- Developer hub: <https://developer.visma.com/api/e-conomic>
- Authentication: <https://www.e-conomic.com/developer/authentication>

## License

Apache-2.0. See [LICENSE](LICENSE).
