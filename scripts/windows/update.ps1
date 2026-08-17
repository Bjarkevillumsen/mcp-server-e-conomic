[CmdletBinding()]
param([Parameter(Mandatory)][string]$Package)

. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-EconomicMcpAdministrator
$installRoot = Assert-EconomicMcpKnownRoot -Path $script:EconomicMcpInstallRoot -Kind Install
$dataRoot = Assert-EconomicMcpKnownRoot -Path $script:EconomicMcpDataRoot -Kind Data
if (-not (Get-EconomicMcpService)) { throw 'EconomicMcp is not installed; use install.ps1.' }

$packagePath = (Resolve-Path -LiteralPath $Package).Path
if ([IO.Path]::GetExtension($packagePath) -ne '.zip') { throw 'Update package must be a Stage 1 ZIP release.' }
$incomingRoot = Join-Path $dataRoot "releases\incoming-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $incomingRoot -Force | Out-Null
Expand-Archive -LiteralPath $packagePath -DestinationPath $incomingRoot
$manifest = Test-EconomicMcpPackageRoot -Root $incomingRoot
$currentVersion = if (Test-Path -LiteralPath (Join-Path $installRoot 'release-manifest.json')) {
    (Get-Content -LiteralPath (Join-Path $installRoot 'release-manifest.json') -Raw | ConvertFrom-Json).stage1Version
} else { 'unknown' }
$backupName = "backup-$((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))-$currentVersion-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
$backupRoot = $null

try {
    Stop-EconomicMcpService
    $backupRoot = New-EconomicMcpBackup -Name $backupName
    foreach ($item in @('app','service','scripts','caddy')) {
        $target = Join-Path $installRoot $item
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
        Copy-Item -LiteralPath (Join-Path $incomingRoot $item) -Destination $target -Recurse -Force
    }
    Copy-Item -LiteralPath (Join-Path $incomingRoot 'release-manifest.json') -Destination $installRoot -Force
    Copy-Item -LiteralPath (Join-Path $incomingRoot 'config\stage1.env.example') -Destination (Join-Path $dataRoot 'config') -Force
    Copy-Item -LiteralPath (Join-Path $incomingRoot 'config\companies.stage1.example.json') -Destination (Join-Path $dataRoot 'config') -Force
    Copy-Item -LiteralPath (Join-Path $incomingRoot 'config\companies-import.example.csv') -Destination (Join-Path $dataRoot 'config') -Force
    Set-EconomicMcpAcls
    Start-Service -Name $script:EconomicMcpServiceName
    & (Join-Path $installRoot 'scripts\windows\healthcheck.ps1') -Retries 12 -RetryDelaySeconds 2
    Write-Host "Updated EconomicMcp Stage 1 to $($manifest.stage1Version). Rollback copy: $backupRoot"
} catch {
    if ($backupRoot -and (Test-Path -LiteralPath $backupRoot)) {
        Stop-EconomicMcpService
        Restore-EconomicMcpBackup -BackupRoot $backupRoot
        Set-EconomicMcpAcls
        Start-Service -Name $script:EconomicMcpServiceName
    }
    throw
} finally {
    $resolvedIncoming = [IO.Path]::GetFullPath($incomingRoot)
    $expectedIncomingParent = [IO.Path]::GetFullPath((Join-Path $dataRoot 'releases')).TrimEnd('\') + '\'
    if ($resolvedIncoming.StartsWith($expectedIncomingParent, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $resolvedIncoming)) {
        Remove-Item -LiteralPath $resolvedIncoming -Recurse -Force
    }
}
