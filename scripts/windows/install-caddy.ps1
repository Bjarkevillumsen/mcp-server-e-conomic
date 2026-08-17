[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$')]
    [string]$HostName,
    [switch]$OpenFirewall,
    [switch]$Start
)

. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-EconomicMcpAdministrator

$packageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$manifest = Test-EconomicMcpPackageRoot -Root $packageRoot
$installRoot = 'C:\Program Files\Caddy'
$dataRoot = 'C:\ProgramData\Caddy'
$serviceName = 'Caddy'
$firewallRuleName = 'EconomicMcp-Caddy-HTTPS'

if (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
    throw 'Caddy is already installed. Use the documented maintenance procedure instead of overwriting a running proxy.'
}

$sourceCaddy = Join-Path $packageRoot 'caddy\caddy.exe'
$sourceLicense = Join-Path $packageRoot 'caddy\Caddy-LICENSE.txt'
$sourceWrapper = Join-Path $packageRoot 'service\CaddyService.exe'
$sourceServiceConfig = Join-Path $packageRoot 'service\CaddyService.xml'
$sourceCaddyfile = Join-Path $packageRoot 'config\Caddyfile.example'
foreach ($source in @($sourceCaddy,$sourceLicense,$sourceWrapper,$sourceServiceConfig,$sourceCaddyfile)) {
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Release package is missing $source." }
}

foreach ($directory in @(
    $installRoot,
    (Join-Path $dataRoot 'config'),
    (Join-Path $dataRoot 'data'),
    (Join-Path $dataRoot 'logs')
)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }

Copy-Item -LiteralPath $sourceCaddy -Destination (Join-Path $installRoot 'caddy.exe') -Force
Copy-Item -LiteralPath $sourceLicense -Destination (Join-Path $installRoot 'Caddy-LICENSE.txt') -Force
Copy-Item -LiteralPath $sourceWrapper -Destination (Join-Path $installRoot 'CaddyService.exe') -Force
Copy-Item -LiteralPath $sourceServiceConfig -Destination (Join-Path $installRoot 'CaddyService.xml') -Force

$caddyfile = [IO.File]::ReadAllText($sourceCaddyfile).Replace('{{MCP_HOSTNAME}}', $HostName.ToLowerInvariant())
$targetCaddyfile = Join-Path $dataRoot 'config\Caddyfile'
[IO.File]::WriteAllText($targetCaddyfile, $caddyfile, [Text.UTF8Encoding]::new($false))

$caddyExe = Join-Path $installRoot 'caddy.exe'
& $caddyExe validate --config $targetCaddyfile --adapter caddyfile
if ($LASTEXITCODE -ne 0) { throw 'Caddy rejected the generated configuration.' }

$serviceIdentity = 'NT AUTHORITY\LOCAL SERVICE'
& icacls.exe $installRoot /inheritance:e /grant:r "${serviceIdentity}:(OI)(CI)RX" /T /C | Out-Null
& icacls.exe (Join-Path $dataRoot 'config') /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F' "${serviceIdentity}:(OI)(CI)RX" /T /C | Out-Null
foreach ($writable in @('data','logs')) {
    & icacls.exe (Join-Path $dataRoot $writable) /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F' "${serviceIdentity}:(OI)(CI)M" /T /C | Out-Null
}

$serviceExe = Join-Path $installRoot 'CaddyService.exe'
& $serviceExe install
if ($LASTEXITCODE -ne 0) { throw 'WinSW failed to install the Caddy service.' }
& sc.exe @('config', $serviceName, 'obj=', $serviceIdentity) | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to assign Caddy to the LocalService account.' }

if ($OpenFirewall) {
    Get-NetFirewallRule -Name $firewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -Name $firewallRuleName -DisplayName 'e-conomic MCP HTTPS via Caddy' `
        -Group 'EconomicMcp' -Direction Inbound -Action Allow -Enabled True -Profile Any `
        -Protocol TCP -LocalPort 443 | Out-Null
}

if ($Start) {
    Start-Service -Name $serviceName
    (Get-Service -Name $serviceName).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
}

Write-Host "Installed Caddy $($manifest.caddy.version) for https://$($HostName.ToLowerInvariant())."
if (-not $OpenFirewall) { Write-Host 'Windows Firewall TCP 443 remains closed; rerun the approved firewall step before public cutover.' }
if (-not $Start) { Write-Host 'Caddy remains stopped; start it only after the origin and public cutover checks are ready.' }
