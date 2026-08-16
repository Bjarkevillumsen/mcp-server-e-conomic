[CmdletBinding()]
param(
    [ValidateRange(1,65535)][int]$Port = 3000,
    [ValidateRange(1,60)][int]$Retries = 1,
    [ValidateRange(1,30)][int]$RetryDelaySeconds = 2,
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$uri = "http://127.0.0.1:$Port/healthz"
$lastError = $null
for ($attempt = 1; $attempt -le $Retries; $attempt += 1) {
    try {
        $response = Invoke-RestMethod -UseBasicParsing -Uri $uri -Method Get -TimeoutSec 10
        $properties = @($response.PSObject.Properties.Name)
        if ($response.status -ne 'ok' -or $properties.Count -ne 1) {
            throw 'Health endpoint returned an unexpected payload.'
        }
        if (-not $Quiet) { Write-Host "EconomicMcp health check passed at $uri" }
        exit 0
    } catch {
        $lastError = $_.Exception.Message
        if ($attempt -lt $Retries) { Start-Sleep -Seconds $RetryDelaySeconds }
    }
}
throw "EconomicMcp health check failed at localhost: $lastError"
