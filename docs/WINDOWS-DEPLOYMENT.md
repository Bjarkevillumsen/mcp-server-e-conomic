# Windows deployment

## Prerequisites

- 64-bit supported Windows Server, current security updates, synchronized time,
  and outbound internet access described in `NETWORK-DESIGN.md`.
- Elevated PowerShell for install/update/rollback/uninstall only.
- A supported Node.js LTS runtime satisfying `>=20.11` (Node 22 LTS is the
  deployment baseline). Normal service execution does not require administrator.
- A verified `EconomicMcp-Stage1-x.y.z.zip` from the tagged GitHub release.
- Entra IDs, one e-conomic token pair per company, company IDs/access lists,
  public hostname/origin, and approved CORS origins.

The package contains compiled application files, production-only npm
dependencies, deployment scripts, configuration templates, documentation, a
checksum-pinned WinSW wrapper, and the checksum-verified Caddy Windows binary.
Codex, TypeScript, npm, build tools, and source are not required on the
production server.

## Filesystem and service identity

Installation creates:

```text
C:\Program Files\EconomicMcp\
    app\
    caddy\
    service\
    scripts\
    release-manifest.json

C:\ProgramData\EconomicMcp\
    config\
    logs\
    audit\
    releases\
```

WinSW registers automatic service `EconomicMcp`, restarts it on failure, and
runs it as the dedicated virtual account `NT SERVICE\EconomicMcp`. That identity
has read/execute on program/config files and modify only on logs/audit. Runtime
Node path is pinned in the protected `node.path` file.

## Install

Extract the ZIP to a temporary administrator-controlled directory. Verify the
GitHub release source and optionally compare file SHA-256 values with
`release-manifest.json`. Prepare a real environment file from
`config\stage1.env.example`; company secrets are added afterward through the
interactive helper and never placed in the environment template.

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\windows\install.ps1 -EnvironmentFile C:\SecureStaging\stage1.env
& 'C:\Program Files\EconomicMcp\scripts\windows\set-company.ps1' `
  -CompanyId 'squaremeter' -DisplayName 'SquareMeter' `
  -AgreementNumber '1382005' -Start
```

Running `.\scripts\windows\install.ps1` without parameters installs the service
stopped and creates a placeholder `stage1.env`; edit the protected ProgramData
copy, then run `set-company.ps1` before starting. The application fails closed
if required values, policy, or the protected 1-100 company registry are
missing/unsafe.

When upgrading a legacy single-company installation, stop the service once and
run the helper with `-UseLegacyCredentials`; it migrates the existing tokens
without displaying them and removes their duplicate environment entries.

After installation, configure either Cloudflare Tunnel or Caddy. For the Caddy
path, follow `CADDY-WINDOWS.md` and open/forward only TCP 443 after local checks.
Then verify localhost binding, health, OAuth metadata, no-token 401, Entra role
behavior, and e-conomic reads.

## Update and rollback

Copy the new signed/verified ZIP to the server, then run the installed script:

```powershell
& 'C:\Program Files\EconomicMcp\scripts\windows\update.ps1' `
  -Package C:\SecureStaging\EconomicMcp-Stage1-0.1.1.zip
```

Update expands and validates the package, stops the service, retains the current
application under ProgramData releases, replaces only app/service/scripts,
preserves secrets/audit/logs, reapplies ACLs, starts, and health-checks. A failed
update automatically attempts to restore its backup.

```powershell
& 'C:\Program Files\EconomicMcp\scripts\windows\rollback.ps1'
```

Rollback selects the newest `backup-*` release unless `-BackupPath` is supplied,
retains the replaced version as `rollback-out-*`, and health-checks the restored
service. At least one previous release is always retained; prune older releases
only under an approved retention/change procedure.

## Uninstall

```powershell
& 'C:\Program Files\EconomicMcp\scripts\windows\uninstall.ps1'
```

Uninstall removes the service and Program Files payload but preserves config,
logs, audit, and releases by default. Permanent data deletion requires both
`-RemoveData -ConfirmDataRemoval` and PowerShell confirmation. Uninstall does not
remove `cloudflared` or Caddy. Remove the selected public transport separately;
Caddy's dedicated uninstall script preserves certificate state and logs unless
explicit data removal is confirmed.
