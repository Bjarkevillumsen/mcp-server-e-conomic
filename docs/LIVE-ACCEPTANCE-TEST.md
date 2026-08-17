# Live acceptance test — agreement 1382005

## Current report

| Field | Result |
| --- | --- |
| Status | **NOT RUN — live credentials and approved business payloads were not provided** |
| Test date/time | Not run |
| Application version | Stage 1 `0.1.1` candidate |
| Upstream repository | `borgels/mcp-server-e-conomic` |
| Upstream commit | `ee3feef4d9f8fcbcef92357e43f582bc311b34c7` |
| Stage 1 repository commit | Pending PR 4 commit/tag |
| Expected agreement | `1382005` |
| Actual agreement returned | Not queried |
| Read results | Not run |
| Invoice draft number | None created |
| Journal draft reference/number | None created |
| Live RBAC result | Not run; automated tests pass |
| Policy/negative result | Automated tests pass; manual live wrapper not run |

No e-conomic request or mutation is represented as completed by this report.
Live acceptance remains a manual customer-controlled step.

## Preparation

Use an administrator test shell, not the service environment. Load credentials
without writing them to command history, prepare customer-approved invoice and
journal JSON payload files outside the repository, and set:

```powershell
$env:STAGE1_PROFILE = 'true'
$env:ECONOMIC_ENABLE_WRITES = 'true'
$env:ECONOMIC_ENABLE_BOOKING = 'false'
$env:ECONOMIC_EXPECTED_AGREEMENT_NUMBER = '1382005'
$env:ECONOMIC_ALLOW_LIVE_WRITE_TESTS = 'true' # only for the two approved write invocations
```

Also set `ECONOMIC_APP_SECRET_TOKEN`, `ECONOMIC_AGREEMENT_GRANT_TOKEN`, and
`ECONOMIC_POLICY_PATH` securely. Do not commit payloads or secrets. Before every
write, the tooling validates all flags, reads `/self`, and requires the returned
agreement to equal `1382005`; each Stage 1 draft tool repeats `/self` immediately
before its POST. A mismatch sends no mutation and no automatic retry occurs.

## Read acceptance

```powershell
& 'C:\Program Files\EconomicMcp\scripts\windows\test-economic.ps1' -Mode Reads
```

Record company context, customers, suppliers, products, accounts, invoices,
booked entries, projects, budgets, filtering, and pagination. HTTP 403/404 for an
optional module may be recorded as **unsupported by subscription**, not an
application failure. Investigate other failures. The tool prints status only,
not returned accounting datasets.

## Exactly two controlled writes

Run each command once in the approved window:

```powershell
& 'C:\Program Files\EconomicMcp\scripts\windows\test-economic.ps1' `
  -Mode InvoiceDraft -PayloadPath C:\SecureStaging\invoice-draft.json -ConfirmLiveWrite

& 'C:\Program Files\EconomicMcp\scripts\windows\test-economic.ps1' `
  -Mode JournalDraft -PayloadPath C:\SecureStaging\journal-draft.json -ConfirmLiveWrite
```

The invoice tool adds reference `MCP-STAGE1-TEST`. The journal tool forces that
marker into its text. Each command performs one POST, reads the returned draft by
number, rejects evidence of a booked state, and reports only safe identifiers.
Manually open e-conomic and confirm the invoice is unsent/unbooked and the journal
entry is unbooked; record their identifiers in the report table.

Immediately return the live flag to false:

```powershell
$env:ECONOMIC_ALLOW_LIVE_WRITE_TESTS = 'false'
```

## Negative and RBAC acceptance

```powershell
& 'C:\Program Files\EconomicMcp\scripts\windows\test-economic.ps1' -Mode Negative
```

This checks invoice/journal booking, payment, DELETE, and customer/supplier/
product/account updates against the Stage 1 policy and asserts that zero
e-conomic requests were sent. Use `test-entra.ps1` with Reader and DraftCreator
test identities as described in `ENTRA-ID-SETUP.md`; do not invoke a valid draft
tool merely to prove authorization outside the two controlled writes.

## Completion record

Replace the **Current report** values with test timestamp, tagged application and
repository commit, actual `/self` agreement, per-domain read status, both draft
identifiers, live role checks, negative result, unsupported modules, limitations,
and remaining manual work. Never add credentials, tokens, customer datasets, or
full payloads to this document.
