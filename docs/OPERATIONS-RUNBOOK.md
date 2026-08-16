# Operations runbook

## Daily checks

- `Get-Service EconomicMcp,cloudflared` reports Running.
- `healthcheck.ps1` passes locally and public `GET /healthz` returns exactly
  `{"status":"ok"}`.
- Port 3000 listens only on `127.0.0.1`.
- Review technical logs for authentication/authorization spikes, policy denials,
  upstream errors, and latency. Review the separate audit JSONL for every draft
  attempt. Never copy tokens or full accounting data into incident systems.
- Monitor disk usage in logs/audit/releases and retain audit data according to
  customer policy.

## Start, stop, and diagnostics

```powershell
Start-Service EconomicMcp
Stop-Service EconomicMcp
Restart-Service EconomicMcp
& 'C:\Program Files\EconomicMcp\scripts\windows\healthcheck.ps1'
Get-Content 'C:\ProgramData\EconomicMcp\logs\EconomicMcpService.err.log' -Tail 100
Get-Content 'C:\ProgramData\EconomicMcp\audit\audit.jsonl' -Tail 20
```

WinSW log filenames can include rolled dates. Use `Get-ChildItem` to locate the
latest file. Do not print `stage1.env`. Startup diagnostics name missing settings
but do not reveal values.

## Common failures

- **Service restart loop:** inspect wrapper stderr, confirm Node path, environment
  file, Stage 1/policy flags, localhost host, required IDs/tokens, and policy path.
- **Local health fails:** service or Node runtime problem. Cloudflare is not yet
  relevant.
- **Local health passes/public 502:** Cloudflare origin/connector problem; verify
  `http://127.0.0.1:3000`, tunnel service, DNS route, and outbound 7844.
- **401:** missing/malformed/expired/invalid Entra token, wrong issuer/tenant/aud,
  or unavailable JWKS. Check time and tenant metadata without logging the token.
- **403:** token is valid but lacks `Mcp.Access`, an Economic role, or the role for
  the requested tool; also check Enterprise Application assignment.
- **e-conomic 401/403:** rotate/check app and agreement grant tokens and API app
  permissions. Do not weaken the MCP role/policy.
- **Module 403/404:** confirm customer subscription. Optional unsupported modules
  are recorded as such during acceptance.

## Credential rotation

1. Stop the service or schedule a short controlled outage.
2. Create/revoke the credential in its authority (e-conomic, Cloudflare, or Entra).
3. Update the protected runtime file/service configuration without echoing the
   value. For `stage1.env`, preserve its restricted ACL and restart EconomicMcp.
4. For Cloudflare, follow `CLOUDFLARE-TUNNEL.md`, restart connectors so old tunnel
   tokens cannot remain active, and verify connector health.
5. Run health, OAuth, RBAC, safe read, and audit checks. Record the change without
   recording secret material.

## Release change

Follow `WINDOWS-DEPLOYMENT.md`: verify the tagged ZIP and manifest, update,
health-check, test metadata/401/RBAC, perform safe reads, and inspect logs. Do not
run live writes as an update smoke test. If health or security checks fail, use
rollback and preserve the failed release/logs for investigation.

## Incident containment

Stop EconomicMcp for suspected unauthorized draft activity or credential theft.
Revoke affected external credentials and Entra sessions/assignments, rotate tunnel
credentials if relevant, retain audit/log evidence, verify no final booking was
performed, and inspect all `MCP-STAGE1-TEST` and unexpected drafts in e-conomic.
Redeploy only from a trusted artifact. Final booking remains a human e-conomic
action; Stage 1 has no booking recovery function.
