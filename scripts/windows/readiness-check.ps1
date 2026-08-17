[CmdletBinding()]
param(
    [string]$PublicBaseUrl,
    [string]$ProtectedBackupPath,
    [ValidateRange(1, 8760)]
    [int]$MaximumBackupAgeHours = 168
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$dataRoot = 'C:\ProgramData\EconomicMcp'
$configRoot = Join-Path $dataRoot 'config'
$environmentPath = Join-Path $configRoot 'stage1.env'
$registryPath = Join-Path $configRoot 'companies.stage1.json'
$failures = [Collections.Generic.List[string]]::new()
$warnings = [Collections.Generic.List[string]]::new()

function Get-Stage1Setting([string]$Name) {
    $line = Get-Content -LiteralPath $environmentPath |
        Where-Object { $_ -match ('^' + [regex]::Escape($Name) + '=') } |
        Select-Object -Last 1
    if ($null -eq $line) { return $null }
    return ($line -replace ('^' + [regex]::Escape($Name) + '='), '').Trim().Trim('"')
}

foreach ($requiredPath in @($environmentPath, $registryPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        $failures.Add("Required file is missing: $requiredPath")
    }
}
if ($failures.Count -gt 0) { throw ($failures -join [Environment]::NewLine) }

$serviceResults = foreach ($serviceName in @('EconomicMcp', 'Caddy')) {
    $service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -ErrorAction SilentlyContinue
    if (-not $service) {
        $failures.Add("Service is missing: $serviceName")
        [pscustomobject]@{ Name = $serviceName; State = 'Missing'; StartMode = $null }
        continue
    }
    if ($service.State -ne 'Running') { $failures.Add("Service is not running: $serviceName") }
    if ($service.StartMode -ne 'Auto') { $failures.Add("Service is not automatic: $serviceName") }
    [pscustomobject]@{ Name = $serviceName; State = $service.State; StartMode = $service.StartMode }
}

$port3000 = @(Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue)
if ($port3000.Count -ne 1 -or $port3000[0].LocalAddress -ne '127.0.0.1') {
    $failures.Add('TCP 3000 must have exactly one listener on 127.0.0.1.')
}
$port443 = @(Get-NetTCPConnection -State Listen -LocalPort 443 -ErrorAction SilentlyContinue)
if ($port443.Count -eq 0) { $failures.Add('TCP 443 has no listener.') }

$localHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:3000/healthz' -TimeoutSec 10
if ($localHealth.status -ne 'ok') { $failures.Add('Local health response was not ok.') }

if (-not $PublicBaseUrl) { $PublicBaseUrl = Get-Stage1Setting 'MCP_PUBLIC_BASE_URL' }
if (-not $PublicBaseUrl) {
    $failures.Add('MCP_PUBLIC_BASE_URL is missing.')
} else {
    $publicHealth = Invoke-RestMethod -Uri "$($PublicBaseUrl.TrimEnd('/'))/healthz" -TimeoutSec 15
    if ($publicHealth.status -ne 'ok') { $failures.Add('Public health response was not ok.') }
}

$expectedSettings = [ordered]@{
    NODE_ENV = 'production'
    STAGE1_PROFILE = 'true'
    MCP_HTTP_HOST = '127.0.0.1'
    ECONOMIC_ENABLE_WRITES = 'true'
    ECONOMIC_ENABLE_BOOKING = 'false'
}
foreach ($entry in $expectedSettings.GetEnumerator()) {
    if ((Get-Stage1Setting $entry.Key) -ne $entry.Value) {
        $failures.Add("Unsafe or missing setting: $($entry.Key)")
    }
}

$registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
$companyCount = @($registry.companies).Count
if ($registry.version -ne 1 -or $companyCount -lt 1 -or $companyCount -gt 100) {
    $failures.Add('Company registry version or company count is invalid.')
}

$backupResult = [pscustomobject]@{ Checked = $false; LatestUtc = $null; AgeHours = $null }
if ($ProtectedBackupPath) {
    $resolvedBackup = [IO.Path]::GetFullPath($ProtectedBackupPath)
    foreach ($unsafeRoot in @('C:\ProgramData\EconomicMcp', 'C:\Program Files\EconomicMcp')) {
        $unsafePrefix = [IO.Path]::GetFullPath($unsafeRoot).TrimEnd('\') + '\'
        if ($resolvedBackup.StartsWith($unsafePrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'ProtectedBackupPath must be outside the EconomicMcp application and data roots.'
        }
    }
    $latestBackup = Get-ChildItem -LiteralPath $resolvedBackup -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    if (-not $latestBackup) {
        $failures.Add('No protected off-host/off-volume backup was found.')
    } else {
        $ageHours = ((Get-Date).ToUniversalTime() - $latestBackup.LastWriteTimeUtc).TotalHours
        if ($ageHours -gt $MaximumBackupAgeHours) { $failures.Add('The latest protected backup is too old.') }
        $backupResult = [pscustomobject]@{
            Checked = $true
            LatestUtc = $latestBackup.LastWriteTimeUtc
            AgeHours = [Math]::Round($ageHours, 1)
        }
    }
} else {
    $warnings.Add('Protected off-host/off-volume backup was not checked; pass -ProtectedBackupPath for production sign-off.')
}

$result = [pscustomobject]@{
    Status = if ($failures.Count) { 'fail' } elseif ($warnings.Count) { 'warning' } else { 'pass' }
    CheckedAtUtc = (Get-Date).ToUniversalTime().ToString('o')
    Services = @($serviceResults)
    LocalHealth = $localHealth.status
    PublicBaseUrl = $PublicBaseUrl
    Companies = $companyCount
    ProtectedBackup = $backupResult
    Warnings = @($warnings)
    Failures = @($failures)
}
$result | ConvertTo-Json -Depth 5
if ($failures.Count) { exit 1 }
