$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$script:EconomicMcpServiceName = 'EconomicMcp'
$script:EconomicMcpInstallRoot = 'C:\Program Files\EconomicMcp'
$script:EconomicMcpDataRoot = 'C:\ProgramData\EconomicMcp'

function Assert-EconomicMcpAdministrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run this script from an elevated PowerShell session.'
    }
}

function Assert-EconomicMcpKnownRoot {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][ValidateSet('Install','Data')][string]$Kind)
    $resolved = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $expected = if ($Kind -eq 'Install') { $script:EconomicMcpInstallRoot } else { $script:EconomicMcpDataRoot }
    if (-not $resolved.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing filesystem operation outside the fixed EconomicMcp $Kind root."
    }
    return $resolved
}

function Get-EconomicMcpService {
    return Get-Service -Name $script:EconomicMcpServiceName -ErrorAction SilentlyContinue
}

function Stop-EconomicMcpService {
    $service = Get-EconomicMcpService
    if ($service -and $service.Status -ne 'Stopped') {
        Stop-Service -Name $script:EconomicMcpServiceName -Force
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(45))
    }
}

function Test-EconomicMcpPackageRoot {
    param([Parameter(Mandatory)][string]$Root)
    $required = @(
        'release-manifest.json',
        'app\dist\transports\stage1-http-main.js',
        'app\node_modules',
        'service\EconomicMcpService.exe',
        'service\EconomicMcpService.xml',
        'service\CaddyService.exe',
        'service\CaddyService.xml',
        'service\start-service.ps1',
        'scripts\windows\healthcheck.ps1',
        'scripts\windows\healthcheck-caddy.ps1',
        'scripts\windows\install-caddy.ps1',
        'scripts\windows\uninstall-caddy.ps1',
        'caddy\caddy.exe',
        'caddy\Caddy-LICENSE.txt',
        'config\Caddyfile.example',
        'config\economic-policy.stage1.json',
        'config\stage1.env.example',
        'config\companies.stage1.example.json',
        'config\companies-import.example.csv',
        'scripts\windows\set-company.ps1',
        'scripts\windows\import-companies.ps1'
    )
    foreach ($relative in $required) {
        if (-not (Test-Path -LiteralPath (Join-Path $Root $relative))) {
            throw "Invalid Stage 1 release package; missing $relative."
        }
    }
    $manifest = Get-Content -LiteralPath (Join-Path $Root 'release-manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.package -ne 'EconomicMcp-Stage1' -or $manifest.stage1Version -notmatch '^\d+\.\d+\.\d+') {
        throw 'Invalid Stage 1 release manifest identity or version.'
    }

    $rootPrefix = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $expectedFiles = @{}
    foreach ($file in @($manifest.files)) {
        if (-not $file.path -or $file.sha256 -notmatch '^[0-9a-fA-F]{64}$') {
            throw 'Invalid file entry in Stage 1 release manifest.'
        }
        $relative = ([string]$file.path).Replace('/','\')
        $target = [IO.Path]::GetFullPath((Join-Path $Root $relative))
        if ([IO.Path]::IsPathRooted($relative) -or -not $target.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Unsafe path in Stage 1 release manifest.'
        }
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Release file missing: $relative" }
        $actualHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
        if ($actualHash -ne [string]$file.sha256) { throw "Release checksum mismatch: $relative" }
        $expectedFiles[$relative.ToLowerInvariant()] = $true
    }

    $actualFiles = Get-ChildItem -LiteralPath $Root -File -Recurse | Where-Object { $_.FullName -ne (Join-Path $Root 'release-manifest.json') }
    foreach ($actual in $actualFiles) {
        $relative = $actual.FullName.Substring($rootPrefix.Length).ToLowerInvariant()
        if (-not $expectedFiles.ContainsKey($relative)) { throw "Unexpected unverified release file: $relative" }
    }
    if ($actualFiles.Count -ne $expectedFiles.Count) { throw 'Release manifest file count mismatch.' }
    return $manifest
}

function New-EconomicMcpBackup {
    param([Parameter(Mandatory)][string]$Name)
    $dataRoot = Assert-EconomicMcpKnownRoot -Path $script:EconomicMcpDataRoot -Kind Data
    $installRoot = Assert-EconomicMcpKnownRoot -Path $script:EconomicMcpInstallRoot -Kind Install
    $backupRoot = Join-Path $dataRoot "releases\$Name"
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    foreach ($item in @('app','service','scripts','caddy','release-manifest.json')) {
        $source = Join-Path $installRoot $item
        if (Test-Path -LiteralPath $source) {
            Copy-Item -LiteralPath $source -Destination $backupRoot -Recurse -Force
        }
    }
    $activePolicy = Join-Path $dataRoot 'config\economic-policy.stage1.json'
    if (Test-Path -LiteralPath $activePolicy -PathType Leaf) {
        Copy-Item -LiteralPath $activePolicy -Destination (Join-Path $backupRoot 'economic-policy.stage1.json') -Force
    }
    return $backupRoot
}

function Restore-EconomicMcpBackup {
    param([Parameter(Mandatory)][string]$BackupRoot)
    $installRoot = Assert-EconomicMcpKnownRoot -Path $script:EconomicMcpInstallRoot -Kind Install
    $resolvedBackup = (Resolve-Path -LiteralPath $BackupRoot).Path
    $expectedParent = [IO.Path]::GetFullPath((Join-Path $script:EconomicMcpDataRoot 'releases')).TrimEnd('\') + '\'
    if (-not $resolvedBackup.StartsWith($expectedParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to restore from outside the EconomicMcp releases directory.'
    }
    foreach ($item in @('app','service','scripts','caddy')) {
        $target = Join-Path $installRoot $item
        if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
        $source = Join-Path $resolvedBackup $item
        if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $target -Recurse -Force }
    }
    $manifest = Join-Path $resolvedBackup 'release-manifest.json'
    if (Test-Path -LiteralPath $manifest) {
        Copy-Item -LiteralPath $manifest -Destination (Join-Path $installRoot 'release-manifest.json') -Force
    }
    $policyBackup = Join-Path $resolvedBackup 'economic-policy.stage1.json'
    if (Test-Path -LiteralPath $policyBackup -PathType Leaf) {
        Copy-Item -LiteralPath $policyBackup -Destination (Join-Path $script:EconomicMcpDataRoot 'config\economic-policy.stage1.json') -Force
    }
}

function Set-EconomicMcpAcls {
    $serviceIdentity = "NT SERVICE\$script:EconomicMcpServiceName"
    $installRoot = Assert-EconomicMcpKnownRoot -Path $script:EconomicMcpInstallRoot -Kind Install
    $dataRoot = Assert-EconomicMcpKnownRoot -Path $script:EconomicMcpDataRoot -Kind Data
    & icacls.exe $installRoot /grant:r "${serviceIdentity}:(OI)(CI)RX" /T /C | Out-Null
    & icacls.exe (Join-Path $dataRoot 'config') /grant:r "${serviceIdentity}:(OI)(CI)RX" /T /C | Out-Null
    foreach ($writable in @('logs','audit')) {
        & icacls.exe (Join-Path $dataRoot $writable) /grant:r "${serviceIdentity}:(OI)(CI)M" /T /C | Out-Null
    }
    $environmentFile = Join-Path $dataRoot 'config\stage1.env'
    if (Test-Path -LiteralPath $environmentFile) {
        & icacls.exe $environmentFile /inheritance:r /grant:r 'SYSTEM:F' 'BUILTIN\Administrators:F' "${serviceIdentity}:R" | Out-Null
    }
    $companyRegistry = Join-Path $dataRoot 'config\companies.stage1.json'
    if (Test-Path -LiteralPath $companyRegistry) {
        & icacls.exe $companyRegistry /inheritance:r /grant:r 'SYSTEM:F' 'BUILTIN\Administrators:F' "${serviceIdentity}:R" | Out-Null
    }
}
