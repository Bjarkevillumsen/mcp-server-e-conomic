[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$service = Get-Service -Name Caddy -ErrorAction Stop
if ($service.Status -ne 'Running') { throw "Caddy is $($service.Status), expected Running." }

$caddyExe = 'C:\Program Files\Caddy\caddy.exe'
$caddyfile = 'C:\ProgramData\Caddy\config\Caddyfile'
& $caddyExe validate --config $caddyfile --adapter caddyfile | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Caddy configuration validation failed.' }

$httpsListeners = @(Get-NetTCPConnection -State Listen -LocalPort 443 -ErrorAction SilentlyContinue)
if ($httpsListeners.Count -eq 0) { throw 'Caddy is not listening on TCP 443.' }

$originListeners = @(Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue)
if ($originListeners.Count -gt 0 -and @($originListeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1','::1') }).Count -gt 0) {
    throw 'MCP port 3000 is exposed beyond loopback.'
}

Write-Host "Caddy health check passed. HTTPS listeners: $($httpsListeners.LocalAddress -join ', ')."
