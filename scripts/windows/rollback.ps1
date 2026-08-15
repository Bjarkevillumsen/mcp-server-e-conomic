[CmdletBinding()]
param([string]$BackupPath)

. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-EconomicMcpAdministrator
$dataRoot = Assert-EconomicMcpKnownRoot -Path $script:EconomicMcpDataRoot -Kind Data
if (-not (Get-EconomicMcpService)) { throw 'EconomicMcp is not installed.' }

if (-not $BackupPath) {
    $BackupPath = Get-ChildItem -LiteralPath (Join-Path $dataRoot 'releases') -Directory -Filter 'backup-*' |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $BackupPath -or -not (Test-Path -LiteralPath $BackupPath -PathType Container)) {
    throw 'No rollback release was found.'
}

Stop-EconomicMcpService
$currentBackup = New-EconomicMcpBackup -Name "rollback-out-$((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))-$([Guid]::NewGuid().ToString('N').Substring(0,8))"
try {
    Restore-EconomicMcpBackup -BackupRoot $BackupPath
    Set-EconomicMcpAcls
    Start-Service -Name $script:EconomicMcpServiceName
    & (Join-Path $script:EconomicMcpInstallRoot 'scripts\windows\healthcheck.ps1') -Retries 12 -RetryDelaySeconds 2
    Write-Host "Rolled back EconomicMcp from $BackupPath. Replaced version retained at $currentBackup"
} catch {
    Stop-EconomicMcpService
    Restore-EconomicMcpBackup -BackupRoot $currentBackup
    Set-EconomicMcpAcls
    Start-Service -Name $script:EconomicMcpServiceName
    throw
}
