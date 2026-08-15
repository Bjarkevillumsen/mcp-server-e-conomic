[CmdletBinding()]
param(
    [string]$Version,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\artifacts'),
    [string]$WinSWPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $Version) { $Version = (Get-Content -LiteralPath (Join-Path $repositoryRoot 'STAGE1_VERSION') -Raw).Trim() }
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Version must be a semantic version without a leading v.' }

$winSwVersion = '2.12.0'
$winSwSha256 = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA'
$winSwUrl = "https://github.com/winsw/winsw/releases/download/v$winSwVersion/WinSW-x64.exe"
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "EconomicMcpRelease-$([Guid]::NewGuid().ToString('N'))"
$stageRoot = Join-Path $temporaryRoot 'package'
$outputRoot = [IO.Path]::GetFullPath($OutputDirectory)
$archivePath = Join-Path $outputRoot "EconomicMcp-Stage1-$Version.zip"

try {
    Push-Location $repositoryRoot
    try {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
        & npm.cmd run typecheck
        if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed.' }
        & npm.cmd test
        if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
        & npm.cmd run build
        if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
        & npm.cmd audit --omit=dev
        if ($LASTEXITCODE -ne 0) { throw 'Production dependency audit failed.' }
    } finally { Pop-Location }

    New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
    foreach ($directory in @('app','service','scripts','config','docs')) {
        New-Item -ItemType Directory -Path (Join-Path $stageRoot $directory) -Force | Out-Null
    }

    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'dist') -Destination (Join-Path $stageRoot 'app\dist') -Recurse
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'package.json') -Destination (Join-Path $stageRoot 'app')
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'package-lock.json') -Destination (Join-Path $stageRoot 'app')
    Push-Location (Join-Path $stageRoot 'app')
    try {
        & npm.cmd ci --omit=dev --ignore-scripts
        if ($LASTEXITCODE -ne 0) { throw 'Runtime dependency installation failed.' }
    } finally { Pop-Location }

    Copy-Item -Path (Join-Path $repositoryRoot 'service\*') -Destination (Join-Path $stageRoot 'service') -Recurse
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'scripts\windows') -Destination (Join-Path $stageRoot 'scripts\windows') -Recurse
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'config\economic-policy.stage1.json') -Destination (Join-Path $stageRoot 'config')
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'config\stage1.env.example') -Destination (Join-Path $stageRoot 'config')
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'config\cloudflared-ingress.example.yml') -Destination (Join-Path $stageRoot 'config')
    Copy-Item -Path (Join-Path $repositoryRoot 'docs\*') -Destination (Join-Path $stageRoot 'docs') -Recurse
    foreach ($file in @('LICENSE','NOTICE','THIRD_PARTY_NOTICES.md','UPSTREAM_COMMIT','STAGE1_VERSION')) {
        Copy-Item -LiteralPath (Join-Path $repositoryRoot $file) -Destination $stageRoot
    }

    $resolvedWinSW = if ($WinSWPath) {
        (Resolve-Path -LiteralPath $WinSWPath).Path
    } else {
        $download = Join-Path $temporaryRoot 'WinSW-x64.exe'
        Invoke-WebRequest -UseBasicParsing -Uri $winSwUrl -OutFile $download
        $download
    }
    $actualWinSwHash = (Get-FileHash -LiteralPath $resolvedWinSW -Algorithm SHA256).Hash
    if ($actualWinSwHash -ne $winSwSha256) { throw 'WinSW SHA-256 verification failed.' }
    Copy-Item -LiteralPath $resolvedWinSW -Destination (Join-Path $stageRoot 'service\EconomicMcpService.exe')

    $upstreamCommit = (Get-Content -LiteralPath (Join-Path $repositoryRoot 'UPSTREAM_COMMIT') -Raw).Trim()
    $repositoryCommit = (& git -C $repositoryRoot rev-parse HEAD).Trim()
    $dirty = [bool](& git -C $repositoryRoot status --porcelain)
    $hashes = Get-ChildItem -LiteralPath $stageRoot -File -Recurse | Sort-Object FullName | ForEach-Object {
        [ordered]@{
            path = [IO.Path]::GetRelativePath($stageRoot, $_.FullName).Replace('\','/')
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }
    $manifest = [ordered]@{
        package = 'EconomicMcp-Stage1'
        stage1Version = $Version
        builtAtUtc = (Get-Date).ToUniversalTime().ToString('o')
        repositoryCommit = $repositoryCommit
        builtFromDirtyWorkingTree = $dirty
        upstreamCommit = $upstreamCommit
        nodeEngine = '>=20.11'
        winSw = [ordered]@{ version = $winSwVersion; sha256 = $winSwSha256.ToLowerInvariant(); source = $winSwUrl }
        files = @($hashes)
    }
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $stageRoot 'release-manifest.json') -Encoding utf8

    . (Join-Path $repositoryRoot 'scripts\windows\Common.ps1')
    Test-EconomicMcpPackageRoot -Root $stageRoot | Out-Null

    New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
    if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
    Compress-Archive -Path (Join-Path $stageRoot '*') -DestinationPath $archivePath -CompressionLevel Optimal
    Write-Host $archivePath
} finally {
    $resolvedTemporary = [IO.Path]::GetFullPath($temporaryRoot)
    $systemTemporary = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolvedTemporary.StartsWith($systemTemporary, [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path $resolvedTemporary -Leaf) -like 'EconomicMcpRelease-*' -and
        (Test-Path -LiteralPath $resolvedTemporary)) {
        Remove-Item -LiteralPath $resolvedTemporary -Recurse -Force
    }
}
