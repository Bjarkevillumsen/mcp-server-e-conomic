[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Reads','InvoiceDraft','JournalDraft','Negative')][string]$Mode,
    [string]$PayloadPath,
    [switch]$ConfirmLiveWrite
)

$ErrorActionPreference = 'Stop'
$isWrite = $Mode -in @('InvoiceDraft','JournalDraft')
if ($isWrite -and -not $ConfirmLiveWrite) {
    throw 'Live draft creation requires -ConfirmLiveWrite in addition to the environment interlocks.'
}
if ($isWrite -and (-not $PayloadPath -or -not (Test-Path -LiteralPath $PayloadPath -PathType Leaf))) {
    throw 'Live draft creation requires an existing -PayloadPath JSON file.'
}

$appRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\app'))
$entryPoint = Join-Path $appRoot 'dist\acceptance\live-stage1.js'
if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) { throw 'Stage 1 live acceptance entry point is missing.' }
$nodePathFile = 'C:\ProgramData\EconomicMcp\config\node.path'
$nodePath = if (Test-Path -LiteralPath $nodePathFile) {
    [IO.File]::ReadAllText($nodePathFile).Trim()
} else {
    (Get-Command node.exe -ErrorAction Stop).Source
}

$modeArgument = switch ($Mode) {
    'Reads' { 'reads' }
    'InvoiceDraft' { 'invoice-draft' }
    'JournalDraft' { 'journal-draft' }
    'Negative' { 'negative' }
}
$arguments = @($entryPoint, '--mode', $modeArgument)
if ($PayloadPath) { $arguments += @('--payload', (Resolve-Path -LiteralPath $PayloadPath).Path) }
& $nodePath @arguments
if ($LASTEXITCODE -ne 0) { throw 'Stage 1 e-conomic acceptance test failed.' }
