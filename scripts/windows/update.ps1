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
$policyPath = Join-Path $dataRoot 'config\economic-policy.stage1.json'
$policyBackupName = 'economic-policy.stage1.json'

function Update-Stage1V030PolicyNames {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw 'The active Stage 1 policy file does not exist.'
    }
    try {
        $policy = [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
    } catch {
        throw 'The active Stage 1 policy file is not valid JSON.'
    }
    if ($null -eq $policy.allowedCapabilities -or $policy.allowedCapabilities -is [string]) {
        throw 'The active Stage 1 policy has an invalid allowedCapabilities value.'
    }

    $mapping = @{
        'stage1_create_sales_invoice_draft' = 'economic_create_sales_invoice_draft'
        'stage1_create_journal_draft_entry' = 'economic_create_journal_draft_entry'
    }
    $changed = $false
    $capabilities = @($policy.allowedCapabilities | ForEach-Object {
        $name = [string]$_
        if ($mapping.ContainsKey($name)) {
            $changed = $true
            $mapping[$name]
        } else {
            $name
        }
    } | Select-Object -Unique)
    if (-not $changed) { return }

    $policy.allowedCapabilities = $capabilities
    $temporaryPolicy = Join-Path (Split-Path -Parent $Path) "economic-policy.stage1.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        $json = $policy | ConvertTo-Json -Depth 12
        [IO.File]::WriteAllText($temporaryPolicy, $json, [Text.UTF8Encoding]::new($false))
        [IO.File]::Replace($temporaryPolicy, $Path, $null, $true)
    } finally {
        if (Test-Path -LiteralPath $temporaryPolicy) { Remove-Item -LiteralPath $temporaryPolicy -Force }
    }
}

try {
    Stop-EconomicMcpService
    $backupRoot = New-EconomicMcpBackup -Name $backupName
    Copy-Item -LiteralPath $policyPath -Destination (Join-Path $backupRoot $policyBackupName) -Force
    foreach ($item in @('app','service','scripts','caddy')) {
        $target = Join-Path $installRoot $item
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
        Copy-Item -LiteralPath (Join-Path $incomingRoot $item) -Destination $target -Recurse -Force
    }
    Copy-Item -LiteralPath (Join-Path $incomingRoot 'release-manifest.json') -Destination $installRoot -Force
    Copy-Item -LiteralPath (Join-Path $incomingRoot 'config\stage1.env.example') -Destination (Join-Path $dataRoot 'config') -Force
    Copy-Item -LiteralPath (Join-Path $incomingRoot 'config\companies.stage1.example.json') -Destination (Join-Path $dataRoot 'config') -Force
    Copy-Item -LiteralPath (Join-Path $incomingRoot 'config\companies-import.example.csv') -Destination (Join-Path $dataRoot 'config') -Force
    Update-Stage1V030PolicyNames -Path $policyPath
    Set-EconomicMcpAcls
    Start-Service -Name $script:EconomicMcpServiceName
    & (Join-Path $installRoot 'scripts\windows\healthcheck.ps1') -Retries 12 -RetryDelaySeconds 2
    Write-Host "Updated EconomicMcp Stage 1 to $($manifest.stage1Version). Rollback copy: $backupRoot"
} catch {
    if ($backupRoot -and (Test-Path -LiteralPath $backupRoot)) {
        Stop-EconomicMcpService
        Restore-EconomicMcpBackup -BackupRoot $backupRoot
        $policyBackup = Join-Path $backupRoot $policyBackupName
        if (Test-Path -LiteralPath $policyBackup -PathType Leaf) {
            Copy-Item -LiteralPath $policyBackup -Destination $policyPath -Force
        }
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
