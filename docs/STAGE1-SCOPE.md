# Stage 1 scope

## Outcome

Stage 1 is a thin, self-hosted profile on top of
`borgels/mcp-server-e-conomic`. It permits authenticated AI clients to read
approved e-conomic resources on demand and to create two kinds of unbooked
drafts. Humans remain responsible for reviewing and booking those drafts in
e-conomic.

One deployment supports 1-100 e-conomic agreements. Each registry entry has a
stable `companyId`, display name, expected agreement number, explicit user ACL,
and its own App Secret/Agreement Grant token pair. Tokens live only in the
protected server registry and are never MCP inputs. The current live acceptance
fixture remains agreement `1382005`; that number is an identity assertion, not
a credential.

## Advertised MCP tools

The Stage 1 server will advertise exactly this allowlist:

- `economic_list_companies`
- `economic_get_company_context`
- `economic_describe_data`
- `economic_query`
- `economic_supplier_transactions`
- `economic_create_sales_invoice_draft`
- `economic_create_journal_draft_entry`

Read tools reuse the upstream client, catalog, schemas, endpoint validation,
pagination behavior, and curated workflow implementations. Data is fetched on
demand; Stage 1 does not synchronize or persist a copy of the accounting
system.

`economic_list_companies` returns only companies allowed for the signed-in user.
Every company-specific tool requires one of the returned `companyId` values. Unknown,
disabled, and unauthorized IDs fail with the same response so the registry
cannot be enumerated. Results and audit events identify the selected company but
never expose its credentials.

`economic_describe_data` lists the allowlisted dataset IDs and, for one selected
dataset, its fixed upstream service/resource pair, valid fields, valid operators,
sortable fields, and examples. `economic_query` is GET-only and accepts that
dataset enum plus structured filters. Raw resources, paths, URLs, methods, and
filter DSL strings are not accepted. Invalid field/operator/type combinations
fail locally before an e-conomic request. Page size is 1-100 and the server can
auto-page up to 500 records.

`economic_supplier_transactions` resolves an exact supplier name independently
inside each selected company and fetches that supplier's booked entries for an
inclusive date range. With no company list it fans out over all authorized
companies with bounded concurrency. Per-company `matched`, `no_matches`,
`supplier_not_found`, and `error` states prevent missing data from being reported
as a successful empty answer. A supplier number can only be used with one
explicit company because numbers are agreement-specific.

Read responses remove self links, pagination URLs, object versions, and metadata
blocks. Company identity appears once per result group, not once per accounting
row. Valid empty datasets explicitly return `matchStatus: no_matches`.

## Allowed mutations

Only these business mutations are in scope:

1. Create a sales invoice draft that remains unbooked and unsent.
2. Create an unbooked journal/finance draft entry.

Both operations require the `Economic.DraftCreator` Entra application role,
the delegated `Mcp.Access` scope, an exact agreement-number match, and approval
from the server-side Stage 1 write policy. Successful results are normalized
and written to a separate audit trail without full payloads.

## Explicit exclusions

Stage 1 does not expose booking, sending, posting, payments, open-item matching,
deletes, master-data writes, arbitrary methods or URLs, webhooks, VAT posting,
OCR, RAG/vector storage, automated duplicate detection, an approval portal, or
autonomous bookkeeping. PUT, PATCH, and DELETE are denied. Unsupported customer
modules are reported as acceptance-test limitations rather than silently
reimplemented.

## Deployment boundary

The Windows Server is a standalone runtime host on a network separate from the
customer's corporate LAN. It needs outbound internet access only. Node binds to
`127.0.0.1`; Cloudflare Tunnel is the preferred public HTTPS transport, while
Microsoft Entra ID remains the application identity provider and is validated
inside the MCP service.

## Future Stage 2 recommendations

Any additional write, approval, matching, OCR, search-index, webhook, or
automated-bookkeeping feature requires a separate threat assessment, explicit
customer approval, a new policy profile, and new tests. None is implemented in
Stage 1.
