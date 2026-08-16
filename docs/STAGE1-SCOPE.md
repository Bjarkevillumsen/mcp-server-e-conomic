# Stage 1 scope

## Outcome

Stage 1 is a thin, self-hosted profile on top of
`borgels/mcp-server-e-conomic`. It permits authenticated AI clients to read
approved e-conomic resources on demand and to create two kinds of unbooked
drafts. Humans remain responsible for reviewing and booking those drafts in
e-conomic.

The expected live acceptance agreement is `1382005`. That number is an
identity assertion, never a credential. Authentication uses only
`ECONOMIC_APP_SECRET_TOKEN` and `ECONOMIC_AGREEMENT_GRANT_TOKEN` supplied by
the runtime environment or an approved secret provider.

## Advertised MCP tools

The Stage 1 server will advertise exactly this allowlist:

- `stage1_check_connection`
- `stage1_get_company_context`
- `stage1_search_entities`
- `stage1_get_entity`
- `stage1_get_customer_overview`
- `stage1_get_supplier_overview`
- `stage1_get_product_overview`
- `stage1_get_accounting_entries`
- `stage1_get_sales_documents`
- `stage1_get_project_overview`
- `stage1_get_document`
- `stage1_get_report`
- `stage1_read_economic`
- `stage1_create_sales_invoice_draft`
- `stage1_create_journal_draft_entry`

Read tools reuse the upstream client, catalog, schemas, endpoint validation,
pagination behavior, and curated workflow implementations. Data is fetched on
demand; Stage 1 does not synchronize or persist a copy of the accounting
system.

`stage1_read_economic` is GET-only. It accepts a catalog service and known path
template rather than a URL or method, and it enforces bounded pagination. It is
not an unrestricted HTTP escape hatch.

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
