# Caddy HTTPS reverse proxy on Windows

Use this transport when DNS stays with the customer's existing provider and a
fixed public IPv4 address terminates on the customer's firewall. Caddy handles
public TLS; EconomicMcp still validates every Entra token and remains bound only
to `127.0.0.1:3000`.

## Fixed deployment topology

```text
Claude -> https://mcp.squaremeter.dk/mcp -> public TCP 443
       -> UniFi TCP 443 NAT -> Windows Caddy TCP 443
       -> http://127.0.0.1:3000 -> EconomicMcp
```

Create only the public DNS `A` record and the UniFi TCP 443 port forward. Do not
move authoritative DNS, disable DNSSEC, forward TCP 80, forward TCP 3000, or
create a public Node.js listener. Caddy can complete ACME with TLS-ALPN on 443.

## Package and installation

The release contains the checksum-verified official Caddy Windows AMD64 binary,
its license, a dedicated WinSW service wrapper, and `config/Caddyfile.example`.
From the extracted release, or after EconomicMcp has copied the package files to
Program Files, run in elevated PowerShell:

```powershell
& '.\scripts\windows\install-caddy.ps1' `
  -HostName mcp.squaremeter.dk `
  -OpenFirewall `
  -Start
```

The service runs as `NT AUTHORITY\LOCAL SERVICE`. Program files are read-only to
that identity. Caddy can modify only `C:\ProgramData\Caddy\data` (certificate
state) and `logs`; its Caddyfile is administrator-controlled. The admin endpoint
is loopback-only on port 2019. Access logs roll and Caddy's default credential
redaction remains enabled.

## Public cutover

Before adding the UniFi rule, verify that EconomicMcp passes its localhost health
check, Caddy configuration validates, and only Caddy is listening on TCP 443:

```powershell
& 'C:\Program Files\EconomicMcp\scripts\windows\healthcheck.ps1'
& 'C:\Program Files\EconomicMcp\scripts\windows\healthcheck-caddy.ps1'
Get-NetTCPConnection -State Listen -LocalPort 3000,443 |
  Select-Object LocalAddress,LocalPort,OwningProcess
```

Then configure one UniFi destination NAT/port-forward rule: WAN TCP 443 to the
server's fixed LAN IPv4 TCP 443. Test from a connection outside the LAN. Public
`GET /healthz` must return `{"status":"ok"}`, the OAuth discovery endpoints must
return JSON, and unauthenticated `POST /mcp` must return 401. Direct public TCP
80 and TCP 3000 must fail.

## Certificate and failure handling

Caddy obtains and renews certificates automatically. DNS must resolve to the
current public IP and inbound TCP 443 must reach Caddy for initial issuance and
renewal. Inspect `C:\ProgramData\Caddy\logs` and the Windows service state if
issuance fails. Do not weaken Entra validation or expose port 3000 to bypass a
proxy problem.

Uninstall preserves certificate/configuration data by default:

```powershell
& 'C:\Program Files\EconomicMcp\scripts\windows\uninstall-caddy.ps1'
```

Permanent Caddy data removal requires both `-RemoveData` and
`-ConfirmDataRemoval` plus PowerShell confirmation.
