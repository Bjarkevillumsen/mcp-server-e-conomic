[CmdletBinding()]
param(
    [string]$EnvironmentFile,
    [string]$NodePath,
    [switch]$Start
)

. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-EconomicMcpAdministrator
$installRoot = Assert-EconomicMcpKnownRoot -Path $script:EconomicMcpInstallRoot -Kind Install
$dataRoot = Assert-EconomicMcpKnownRoot -Path $script:EconomicMcpDataRoot -Kind Data
$packageRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$manifest = Test-EconomicMcpPackageRoot -Root $packageRoot

if (Get-EconomicMcpService) { throw 'EconomicMcp is already installed; use update.ps1.' }
if (Test-Path -LiteralPath (Join-Path $installRoot 'app')) {
    throw 'An existing EconomicMcp application directory was found; use update.ps1 or uninstall it first.'
}

if (-not $NodePath) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw 'Node.js 20.11 or newer is required. Install a supported Node.js LTS runtime first.' }
    $NodePath = $nodeCommand.Source
}
$resolvedNode = (Resolve-Path -LiteralPath $NodePath).Path
$nodeVersionText = (& $resolvedNode --version).Trim().TrimStart('v')
if ([Version]$nodeVersionText -lt [Version]'20.11.0') { throw 'Node.js 20.11 or newer is required.' }

foreach ($directory in @(
    $installRoot,
    (Join-Path $dataRoot 'config'),
    (Join-Path $dataRoot 'logs'),
    (Join-Path $dataRoot 'audit'),
    (Join-Path $dataRoot 'releases')
)) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }

foreach ($item in @('app','service','scripts','caddy')) {
    Copy-Item -LiteralPath (Join-Path $packageRoot $item) -Destination (Join-Path $installRoot $item) -Recurse -Force
}
Copy-Item -LiteralPath (Join-Path $packageRoot 'release-manifest.json') -Destination $installRoot -Force
Copy-Item -LiteralPath (Join-Path $packageRoot 'config\economic-policy.stage1.json') -Destination (Join-Path $dataRoot 'config') -Force
Copy-Item -LiteralPath (Join-Path $packageRoot 'config\stage1.env.example') -Destination (Join-Path $dataRoot 'config') -Force
Copy-Item -LiteralPath (Join-Path $packageRoot 'config\companies.stage1.example.json') -Destination (Join-Path $dataRoot 'config') -Force

$targetEnvironment = Join-Path $dataRoot 'config\stage1.env'
if ($EnvironmentFile) {
    Copy-Item -LiteralPath (Resolve-Path -LiteralPath $EnvironmentFile).Path -Destination $targetEnvironment -Force
} elseif (-not (Test-Path -LiteralPath $targetEnvironment)) {
    Copy-Item -LiteralPath (Join-Path $packageRoot 'config\stage1.env.example') -Destination $targetEnvironment
}
[IO.File]::WriteAllText((Join-Path $dataRoot 'config\node.path'), $resolvedNode)

$serviceExe = Join-Path $installRoot 'service\EconomicMcpService.exe'
& $serviceExe install
if ($LASTEXITCODE -ne 0) { throw 'WinSW failed to install the EconomicMcp service.' }
& sc.exe @('config', $script:EconomicMcpServiceName, 'obj=', "NT SERVICE\$script:EconomicMcpServiceName") | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Failed to assign the dedicated EconomicMcp virtual service account.' }
Set-EconomicMcpAcls

if ($Start) {
    Start-Service -Name $script:EconomicMcpServiceName
    & (Join-Path $installRoot 'scripts\windows\healthcheck.ps1') -Retries 12 -RetryDelaySeconds 2
}

Write-Host "Installed EconomicMcp Stage 1 $($manifest.stage1Version) using Node $nodeVersionText."
if (-not $Start) {
    Write-Host "Edit $targetEnvironment, then run: Start-Service $script:EconomicMcpServiceName"
}
