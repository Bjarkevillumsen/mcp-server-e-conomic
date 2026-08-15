$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$dataRoot = 'C:\ProgramData\EconomicMcp'
$environmentFile = Join-Path $dataRoot 'config\stage1.env'
$nodePathFile = Join-Path $dataRoot 'config\node.path'
$entryPoint = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\app\dist\transports\stage1-http-main.js'))

if (-not (Test-Path -LiteralPath $environmentFile -PathType Leaf)) {
    throw "Stage 1 environment file is missing: $environmentFile"
}
if (-not (Test-Path -LiteralPath $nodePathFile -PathType Leaf)) {
    throw "Pinned Node executable path is missing: $nodePathFile"
}
if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
    throw 'Stage 1 application entry point is missing.'
}

foreach ($line in [IO.File]::ReadAllLines($environmentFile)) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
    $separator = $trimmed.IndexOf('=')
    if ($separator -lt 1) { throw 'Invalid stage1.env line; expected KEY=VALUE.' }
    $name = $trimmed.Substring(0, $separator).Trim()
    $value = $trimmed.Substring($separator + 1)
    if ($name -notmatch '^[A-Z][A-Z0-9_]*$') { throw 'Invalid environment variable name in stage1.env.' }
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
}

$nodePath = [IO.File]::ReadAllText($nodePathFile).Trim()
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    throw 'Configured Node executable does not exist.'
}

& $nodePath $entryPoint
exit $LASTEXITCODE
