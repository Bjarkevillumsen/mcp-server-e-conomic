[CmdletBinding()]
param(
    [ValidateSet('WellKnown','NoToken','Authenticated','ReaderWriteDenied')][string]$Mode = 'WellKnown',
    [string]$BaseUrl = $env:MCP_PUBLIC_BASE_URL
)

$ErrorActionPreference = 'Stop'
if (-not $BaseUrl) { throw 'Provide -BaseUrl or set MCP_PUBLIC_BASE_URL.' }
$BaseUrl = $BaseUrl.TrimEnd('/')
$parsedBase = [Uri]$BaseUrl
if ($parsedBase.Scheme -ne 'https' -and $parsedBase.Host -notin @('127.0.0.1','localhost')) {
    throw 'Entra tests require HTTPS except for an explicit localhost test.'
}

function Invoke-StatusRequest {
    param([string]$Uri, [string]$Method, [hashtable]$Headers, [string]$Body)
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -Method $Method -Headers $Headers -Body $Body -ContentType 'application/json' -TimeoutSec 30
        return @{ Status = [int]$response.StatusCode; Content = $response.Content }
    } catch {
        if ($_.Exception.Response) {
            return @{ Status = [int]$_.Exception.Response.StatusCode; Content = '' }
        }
        throw
    }
}

if ($Mode -eq 'WellKnown') {
    $metadata = Invoke-RestMethod -UseBasicParsing -Uri "$BaseUrl/.well-known/oauth-protected-resource" -Method Get -TimeoutSec 30
    if (-not $metadata.resource -or -not $metadata.authorization_servers) { throw 'Protected resource metadata is incomplete.' }
    Write-Host 'OAuth protected-resource metadata check passed.'
    exit 0
}

$headers = @{ Accept = 'application/json, text/event-stream' }
if ($Mode -ne 'NoToken') {
    $token = $env:ENTRA_TEST_ACCESS_TOKEN
    if (-not $token) {
        $secureToken = Read-Host 'Access token (input hidden)' -AsSecureString
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
        try { $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
        finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    }
    $headers.Authorization = "Bearer $token"
}

$body = if ($Mode -eq 'ReaderWriteDenied') {
    @{ jsonrpc = '2.0'; id = 1; method = 'tools/call'; params = @{ name = 'stage1_create_sales_invoice_draft'; arguments = @{} } } | ConvertTo-Json -Depth 8 -Compress
} else {
    @{ jsonrpc = '2.0'; id = 1; method = 'initialize'; params = @{ protocolVersion = '2025-06-18'; capabilities = @{}; clientInfo = @{ name = 'stage1-entra-test'; version = '0.1.2' } } } | ConvertTo-Json -Depth 8 -Compress
}
$result = Invoke-StatusRequest -Uri "$BaseUrl/mcp" -Method Post -Headers $headers -Body $body
$expected = if ($Mode -in @('NoToken','ReaderWriteDenied')) { if ($Mode -eq 'NoToken') { 401 } else { 403 } } else { 200 }
if ($result.Status -ne $expected) { throw "Expected HTTP $expected but received $($result.Status)." }
Write-Host "Entra $Mode check passed with expected HTTP $expected."
$token = $null
