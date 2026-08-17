[CmdletBinding(SupportsShouldProcess, ConfirmImpact='High')]
param(
    [switch]$RemoveData,
    [switch]$ConfirmDataRemoval
)

. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-EconomicMcpAdministrator
$installRoot = 'C:\Program Files\Caddy'
$dataRoot = 'C:\ProgramData\Caddy'
$serviceName = 'Caddy'
$firewallRuleName = 'EconomicMcp-Caddy-HTTPS'

if ($RemoveData -and -not $ConfirmDataRemoval) {
    throw 'Caddy data deletion requires both -RemoveData and -ConfirmDataRemoval.'
}

if ($PSCmdlet.ShouldProcess($serviceName, 'Stop service, close the HTTPS firewall rule, and uninstall the service')) {
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($service -and $service.Status -ne 'Stopped') {
        Stop-Service -Name $serviceName -Force
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
    Get-NetFirewallRule -Name $firewallRuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    $wrapper = Join-Path $installRoot 'CaddyService.exe'
    if (Test-Path -LiteralPath $wrapper) { & $wrapper uninstall }
    elseif ($service) { & sc.exe delete $serviceName | Out-Null }
}

if ((Test-Path -LiteralPath $installRoot) -and $PSCmdlet.ShouldProcess($installRoot, 'Remove Caddy executable and service files')) {
    Remove-Item -LiteralPath $installRoot -Recurse -Force
    Write-Host "Removed Caddy program files from $installRoot."
}
if ($RemoveData -and (Test-Path -LiteralPath $dataRoot) -and $PSCmdlet.ShouldProcess($dataRoot, 'Permanently remove certificates, configuration, and logs')) {
    Remove-Item -LiteralPath $dataRoot -Recurse -Force
    Write-Host "Removed $dataRoot, including certificate state and logs."
} elseif (Test-Path -LiteralPath $dataRoot) {
    Write-Host "Preserved $dataRoot, including certificate state and logs."
}
