[CmdletBinding(SupportsShouldProcess, ConfirmImpact='High')]
param(
    [switch]$RemoveData,
    [switch]$ConfirmDataRemoval
)

. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-EconomicMcpAdministrator
$installRoot = Assert-EconomicMcpKnownRoot -Path $script:EconomicMcpInstallRoot -Kind Install
$dataRoot = Assert-EconomicMcpKnownRoot -Path $script:EconomicMcpDataRoot -Kind Data

if ($RemoveData -and -not $ConfirmDataRemoval) {
    throw 'Data deletion requires both -RemoveData and -ConfirmDataRemoval.'
}

if ($PSCmdlet.ShouldProcess($script:EconomicMcpServiceName, 'Stop and remove Windows service')) {
    Stop-EconomicMcpService
    $serviceExe = Join-Path $installRoot 'service\EconomicMcpService.exe'
    if (Test-Path -LiteralPath $serviceExe) {
        & $serviceExe uninstall
    } elseif (Get-EconomicMcpService) {
        & sc.exe delete $script:EconomicMcpServiceName | Out-Null
    }
}
if ((Test-Path -LiteralPath $installRoot) -and $PSCmdlet.ShouldProcess($installRoot, 'Remove application and service files')) {
    Remove-Item -LiteralPath $installRoot -Recurse -Force
    Write-Host "Removed application files from $installRoot."
}
if ($RemoveData -and (Test-Path -LiteralPath $dataRoot) -and $PSCmdlet.ShouldProcess($dataRoot, 'Permanently remove configuration, logs, audit, and releases')) {
    Remove-Item -LiteralPath $dataRoot -Recurse -Force
    Write-Host "Removed $dataRoot; this includes configuration, logs, audit records, and rollback releases."
} elseif (Test-Path -LiteralPath $dataRoot) {
    Write-Host "Preserved $dataRoot (including configuration and audit records)."
}
