[CmdletBinding()]
param(
    [string]$Version,
    [string]$OutputDirectory,
    [string]$WinSWPath,
    [string]$CaddyZipPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$repositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $repositoryRoot 'artifacts' }
if (-not $Version) { $Version = (Get-Content -LiteralPath (Join-Path $repositoryRoot 'STAGE1_VERSION') -Raw).Trim() }
if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') { throw 'Version must be a semantic version without a leading v.' }

$winSwVersion = '2.12.0'
$winSwSha256 = '05B82D46AD331CC16BDC00DE5C6332C1EF818DF8CEEFCD49C726553209B3A0DA'
$winSwUrl = "https://github.com/winsw/winsw/releases/download/v$winSwVersion/WinSW-x64.exe"
$caddyVersion = '2.11.4'
$caddyZipSha256 = '1708333F79E274C7697285AFE6D592AB39314E0B131E9EC6BEA08AD27DF62EBF'
$caddyZipUrl = "https://github.com/caddyserver/caddy/releases/download/v$caddyVersion/caddy_${caddyVersion}_windows_amd64.zip"
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
    foreach ($directory in @('app','service','scripts','config','docs','caddy')) {
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
    Copy-Item -LiteralPath (Join-Path $repositoryRoot 'config\Caddyfile.example') -Destination (Join-Path $stageRoot 'config')
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
    Copy-Item -LiteralPath $resolvedWinSW -Destination (Join-Path $stageRoot 'service\CaddyService.exe')

    $resolvedCaddyZip = if ($CaddyZipPath) {
        (Resolve-Path -LiteralPath $CaddyZipPath).Path
    } else {
        $download = Join-Path $temporaryRoot 'caddy-windows-amd64.zip'
        Invoke-WebRequest -UseBasicParsing -Uri $caddyZipUrl -OutFile $download
        $download
    }
    $actualCaddyZipHash = (Get-FileHash -LiteralPath $resolvedCaddyZip -Algorithm SHA256).Hash
    if ($actualCaddyZipHash -ne $caddyZipSha256) { throw 'Caddy ZIP SHA-256 verification failed.' }
    $caddyExpanded = Join-Path $temporaryRoot 'caddy-expanded'
    Expand-Archive -LiteralPath $resolvedCaddyZip -DestinationPath $caddyExpanded
    $caddyExe = Join-Path $caddyExpanded 'caddy.exe'
    $caddyLicense = Join-Path $caddyExpanded 'LICENSE'
    if (-not (Test-Path -LiteralPath $caddyExe -PathType Leaf) -or -not (Test-Path -LiteralPath $caddyLicense -PathType Leaf)) {
        throw 'The verified Caddy archive does not contain the expected executable and license.'
    }
    Copy-Item -LiteralPath $caddyExe -Destination (Join-Path $stageRoot 'caddy\caddy.exe')
    Copy-Item -LiteralPath $caddyLicense -Destination (Join-Path $stageRoot 'caddy\Caddy-LICENSE.txt')

    $upstreamCommit = (Get-Content -LiteralPath (Join-Path $repositoryRoot 'UPSTREAM_COMMIT') -Raw).Trim()
    $repositoryCommit = (& git -C $repositoryRoot rev-parse HEAD).Trim()
    $dirty = [bool](& git -C $repositoryRoot status --porcelain)
    $stagePrefix = [IO.Path]::GetFullPath($stageRoot).TrimEnd('\') + '\'
    $hashes = Get-ChildItem -LiteralPath $stageRoot -File -Recurse | Sort-Object FullName | ForEach-Object {
        if (-not $_.FullName.StartsWith($stagePrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Release staging contained a file outside the fixed staging root.'
        }
        [ordered]@{
            path = $_.FullName.Substring($stagePrefix.Length).Replace('\','/')
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
        caddy = [ordered]@{ version = $caddyVersion; zipSha256 = $caddyZipSha256.ToLowerInvariant(); source = $caddyZipUrl }
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
