# Network design

## Required isolation

The Windows Server is on a network separate from the customer's corporate LAN.
There is no route or dependency to the normal LAN, domain controllers, internal
DNS, an internal reverse proxy, or an internal VPN. Do not add one for this MVP.

The application binds only to `127.0.0.1:3000`. There is no public Node.js port
and no inbound firewall rule to the MCP process. The public transport is either
an outbound Cloudflare Tunnel or Caddy terminating TCP 443 and proxying to the
loopback origin.

## Firewall policy

Inbound:

- Deny unsolicited inbound traffic to the host.
- Do not open TCP 3000 on any interface.
- With Caddy, permit inbound TCP 443 only. Do not permit or NAT TCP 80 or 3000.
- Permit administrative access only through the customer's separately approved
  server-management path; it is outside this application design.

Outbound:

- Permit DNS and HTTPS to the configured Microsoft Entra tenant discovery/JWKS
  endpoints and e-conomic (`restapi.e-conomic.com` and `apis.e-conomic.com`).
- When Cloudflare is selected, permit `cloudflared` to Cloudflare Tunnel
  endpoints on port 7844 over TCP and
  UDP. If the firewall performs FQDN/SNI filtering, use Cloudflare's current
  published list rather than hardcoding an old IP list.
- Permit HTTPS 443 for controlled Windows, Node.js, and `cloudflared` updates and
  revocation/PKI services according to host policy.
- Deny unnecessary outbound destinations where the host firewall supports an
  application-aware allowlist.

Cloudflare documents Tunnel as an outbound-only connector using port 7844 over
QUIC or HTTP/2: <https://developers.cloudflare.com/cloudflare-one/networks/connectivity-options/>
and maintains the detailed firewall list here:
<https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/>.

## Verification

Run on the server after each install or update:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3000 |
  Select-Object LocalAddress,LocalPort,OwningProcess
Test-NetConnection 127.0.0.1 -Port 3000
.\scripts\windows\healthcheck.ps1
```

The listener must be `127.0.0.1`, never `0.0.0.0`, `::`, a LAN address, or a
public address. From another machine, direct connections to the server's port
3000 must fail. The public hostname must work only through the HTTPS proxy/tunnel.

## Caddy reverse proxy

Caddy is the packaged alternative when Cloudflare Tunnel is not selected.
Terminate TLS for only the MCP hostname, forward to `http://127.0.0.1:3000`,
preserve request-size and timeout limits, and keep port 3000 loopback-only. The
proxy does not replace Entra JWT validation. Certificate lifecycle, DDoS
controls, fixed-IP NAT, and inbound TCP 443 exposure are explicit customer
responsibilities. See `CADDY-WINDOWS.md`.
