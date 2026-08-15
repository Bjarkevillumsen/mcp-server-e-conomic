# Stage 1 architecture

## Runtime flow

```mermaid
flowchart TD
    Client["Claude, ChatGPT, or another MCP client"] -->|"HTTPS + Entra access token"| CF["Cloudflare public hostname"]
    CF -->|"outbound tunnel connection"| CFD["cloudflared Windows service"]
    CFD -->|"HTTP on 127.0.0.1:3000"| MCP["EconomicMcp Stage 1 service"]
    MCP -->|"OIDC metadata and JWKS"| Entra["Single Microsoft Entra tenant"]
    MCP -->|"outbound HTTPS with e-conomic tokens"| Economic["e-conomic REST and OpenAPI"]
    MCP --> Logs["redacted technical logs"]
    MCP --> Audit["separate JSONL write audit"]
```

The Windows host is a standalone internet-connected runtime. It does not use
the corporate LAN, domain join, Windows integrated authentication, internal DNS,
or a VPN. Cloudflare transports requests; it does not make authorization
decisions for the application. The Node process verifies Entra tokens itself.

## Control flow

Every request crosses independent controls:

1. The Stage 1 server registers only the 15 names in `STAGE1_ALLOWED_TOOLS`.
2. Signed, tenant-specific Entra claims and the requested tool are authorized on
   every invocation. `Economic.Reader` can read; `Economic.DraftCreator` can also
   call the two draft tools.
3. The Stage 1 policy permits only `POST /invoices/drafts` and
   `POST /draft-entries`; all other mutations remain denied even if another
   layer fails.
4. Immediately before either mutation, `/self` must return the configured
   agreement number. Live acceptance is additionally locked to `1382005`.

Reads are on demand, bounded, and catalog-validated. No accounting replica,
vector database, webhook ingestion, or approval database is introduced.
e-conomic remains the system of record and its draft UI is the human approval
boundary.

## Components reused from upstream

The profile reuses the upstream e-conomic client, REST/OpenAPI service catalog,
endpoint materialization, payload normalization, prepared-operation verification,
policy engine, JSONL audit writer, MCP transports, and Vitest fixtures. Customer
logic is isolated under `src/stage1`, `src/acceptance`, the Stage 1 HTTP entry
point, and deployment configuration.

## Availability dependencies

Authentication needs internet access to the tenant-specific Microsoft OIDC/JWKS
endpoints. Business operations need e-conomic HTTPS. Public reachability needs
Cloudflare when the preferred design is used. A failure of any dependency fails
the affected request; it never falls back to unsigned claims, another tenant, a
different e-conomic host, or a broader tool profile.
