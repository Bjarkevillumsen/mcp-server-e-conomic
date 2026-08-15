# Cloudflare Tunnel on Windows

Cloudflare Tunnel is the preferred public transport. Microsoft Entra remains
the identity and authorization layer inside EconomicMcp. Cloudflare Access can
be added later as another control, but must not replace or bypass Entra token
validation.

## Create and route the tunnel

1. In the Cloudflare dashboard, open **Networking > Tunnels**, create a
   remotely-managed tunnel such as `economic-mcp-stage1`, and select Windows.
2. Download the current 64-bit `cloudflared` release from Cloudflare's official
   downloads page. Windows installations do not auto-update, so record the
   installed version and patch it through change management:
   <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/>.
3. From an elevated shell, run the dashboard-provided service command. It has
   the form `cloudflared.exe service install <TUNNEL_TOKEN>`. Treat the token as
   a secret: do not save the command in this repository, transcripts, or tickets.
4. Add a **Published application** route for the approved public hostname with
   service URL `http://127.0.0.1:3000`. Cloudflare's current dashboard procedure
   is documented at
   <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/create-remote-tunnel/>.
5. Ensure the hostname has the Cloudflare-managed DNS route and edge TLS. Set
   the same origin in `MCP_PUBLIC_BASE_URL` and only necessary HTTPS origins in
   `MCP_ALLOWED_ORIGINS`.

For a locally managed tunnel, adapt `config/cloudflared-ingress.example.yml`,
protect the credential JSON with administrator/SYSTEM ACLs, validate with
`cloudflared tunnel ingress validate`, and keep the final `http_status:404`
catch-all. Remotely-managed configuration is recommended for this MVP.

## Firewall and localhost checks

Allow outbound TCP and UDP port 7844 to Cloudflare's current Tunnel endpoints;
do not open an inbound port. Cloudflare's authoritative firewall matrix is
<https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/tunnel-with-firewall/>.
Allow controlled HTTPS 443 for updates as required by host policy.

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3000 |
  Select-Object LocalAddress,LocalPort,OwningProcess
Get-Service EconomicMcp,cloudflared
cloudflared.exe tunnel --metrics localhost:20241 ready
```

The Node listener must show only `127.0.0.1`. Test `GET /healthz` locally and at
the public HTTPS hostname. Then test the protected-resource metadata and 401
response without a token.

## Rotate a tunnel token

Cloudflare's current rotation procedure is at
<https://developers.cloudflare.com/tunnel/advanced/tunnel-tokens/>. In a change
window: rotate in the dashboard, copy the new service-install command securely,
stop/uninstall the old `cloudflared` service, reinstall it with the new token,
start it, and verify a Healthy connector and public health check. Rotation stops
new connections using the old token; existing connectors can remain active until
restarted, so force-disconnect them after suspected compromise.

## Troubleshooting

- **Tunnel down:** check the Windows service, Event Viewer/cloudflared logs,
  system time, DNS, and outbound 7844 TCP/UDP. Run Cloudflare's connectivity
  pre-checks: <https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/connectivity-prechecks/>.
- **502 from Cloudflare:** confirm EconomicMcp is running and local health works;
  the origin must be `http://127.0.0.1:3000`, not HTTPS.
- **401/403:** the tunnel is working. Check Entra audience, tenant, scope, role,
  assignment, and token expiry without logging the token.
- **CORS denial:** add only the exact approved HTTPS client origin and restart the
  service. Never set `MCP_ALLOW_ANY_ORIGIN=true` in production.
- **After update:** Windows `cloudflared` does not auto-update; apply a supported
  release manually and retest. Cloudflare supports recent releases and publishes
  the policy on its downloads page.
