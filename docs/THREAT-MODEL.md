# Threat model

## Assets and trust boundaries

Protected assets are e-conomic credentials and accounting data, Entra access
tokens, the two draft capabilities, policy/configuration, audit integrity, and
service availability. Trust boundaries exist at the selected public transport,
HTTPS-to-loopback proxy, MCP HTTP parser, Entra validation, tool dispatch,
Stage 1 policy, e-conomic API, and Windows filesystem/service manager.

| Threat | Primary controls | Residual risk |
| --- | --- | --- |
| Unauthenticated internet caller | Edge TLS, mandatory signed Entra bearer token, 401, body/time limits | Endpoint metadata and health remain intentionally public and minimal |
| Token from wrong tenant/client | Tenant-specific discovery, issuer/tid/aud checks, RS256 signature, expiry/nbf | Compromised approved account remains an identity-provider incident |
| Reader attempts a write | Role-to-tool mapping checked before dispatch and in callback | Incorrect Entra group assignment can grant intended DraftCreator rights |
| Prompt/tool injection requests booking | Forbidden tools absent; exact write endpoints; policy and tests deny booking/sending/payment/delete | Draft content still requires human review in e-conomic |
| SSRF or credential exfiltration | No URL/method tool input, catalog allowlist, traversal rejection, production host pinning | A compromised Windows administrator can alter deployed code/config |
| Oversized/malformed request or abuse | Proxy and application body limits, JSON/content-type validation, request timeout | Direct Caddy exposure lacks Cloudflare DDoS/rate controls; valid-token abuse needs monitoring |
| Wrong e-conomic agreement | `/self` equality check immediately before each draft; live tooling fixed to `1382005` | Agreement context/API semantics could change and must be revalidated on upgrade |
| Secret leakage in logs/errors | Named and bearer redaction, generic public errors, no payload logging, restricted ACL | Administrator memory/process inspection can recover process secrets |
| Supply-chain/release tampering | Pinned upstream, lockfile, audit, WinSW/Caddy archive checksums, manifest hashes, tagged artifact | GitHub/account compromise requires independent artifact provenance controls |
| Tunnel credential theft | Restricted service config, no repository token, documented rotation | Existing connectors persist until restarted/force-disconnected |
| Service account compromise | Dedicated virtual account, read-only app/config, write only logs/audit, localhost bind | Local privilege escalation is an OS risk outside application controls |
| Audit tampering | Separate JSONL path and restricted ACL; optional central forwarding | Local administrators can alter local evidence |

## Abuse cases proven by tests

Automated tests cover missing/malformed/forged/wrong-issuer/wrong-tenant/
wrong-audience/expired tokens, missing scope/role, both allowed roles, exact tool
advertisement, external URLs, traversal, arbitrary POST, booking, sending,
payments, matching, DELETE, and master-data writes. Live negative acceptance calls
the policy locally and asserts zero e-conomic mutations.

## Out of scope and Stage 2

Endpoint/client-device compromise, Entra tenant administration, public DNS and
firewall administration, Cloudflare administration when selected, Windows
base-image hardening, and the correctness of
human approval in e-conomic are customer operational responsibilities. OCR,
webhooks, RAG, automated duplicate detection, approvals, autonomous booking, and
any new mutation require a new threat assessment and are not implemented.
