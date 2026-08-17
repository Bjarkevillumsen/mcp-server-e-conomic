[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CompanyId,
    [Parameter(Mandatory)][string]$DisplayName,
    [Parameter(Mandatory)][string]$AgreementNumber,
    [string[]]$ReadUserOid = @('*'),
    [string[]]$DraftUserOid = @('*'),
    [switch]$Disabled,
    [switch]$UseLegacyCredentials,
    [switch]$Start
)

. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-EconomicMcpAdministrator
$dataRoot = Assert-EconomicMcpKnownRoot -Path $script:EconomicMcpDataRoot -Kind Data
$configRoot = Join-Path $dataRoot 'config'
$registryPath = Join-Path $configRoot 'companies.stage1.json'
$environmentPath = Join-Path $configRoot 'stage1.env'
$service = Get-EconomicMcpService

if ($service -and $service.Status -ne 'Stopped') {
    throw 'Stop EconomicMcp before changing company credentials.'
}
if ($CompanyId -cnotmatch '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$') {
    throw 'CompanyId must be lowercase letters, digits, or internal hyphens (maximum 64 characters).'
}
if ([string]::IsNullOrWhiteSpace($DisplayName) -or $DisplayName.Length -gt 120 -or $DisplayName -match '[\r\n]') {
    throw 'DisplayName must contain 1-120 characters without line breaks.'
}
if ($AgreementNumber -notmatch '^0*[1-9]\d*$') { throw 'AgreementNumber must be a positive number.' }

function Test-UserSelector {
    param([Parameter(Mandatory)][string[]]$Values, [switch]$AllowEmpty)
    if (-not $AllowEmpty -and $Values.Count -eq 0) { throw 'At least one read selector is required.' }
    if ($Values.Count -gt 500) { throw 'A company access list cannot contain more than 500 selectors.' }
    if ($Values -contains '*' -and $Values.Count -ne 1) { throw 'The wildcard must be the only selector in its list.' }
    foreach ($value in $Values) {
        if ($value -ne '*' -and $value -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$') {
            throw "Invalid Entra user object ID: $value"
        }
    }
}

function Read-SecretPlainText {
    param([Parameter(Mandatory)][string]$Prompt)
    $secure = Read-Host $Prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        if ([string]::IsNullOrWhiteSpace($plain) -or $plain.Length -gt 8192 -or $plain -match '[\r\n]') {
            throw 'A token must contain 1-8192 characters without line breaks.'
        }
        return $plain
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function Read-EnvironmentValues {
    if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) {
        throw "Missing Stage 1 environment file: $environmentPath"
    }
    $values = @{}
    foreach ($line in [IO.File]::ReadAllLines($environmentPath)) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#')) { continue }
        $separator = $trimmed.IndexOf('=')
        if ($separator -lt 1) { continue }
        $values[$trimmed.Substring(0, $separator).Trim()] = $trimmed.Substring($separator + 1)
    }
    return $values
}

function Set-RegistryEnvironmentPath {
    $lines = [Collections.Generic.List[string]]::new()
    $seenRegistryPath = $false
    $temporaryEnvironmentPath = Join-Path $configRoot "stage1.$([Guid]::NewGuid().ToString('N')).tmp"
    foreach ($line in [IO.File]::ReadAllLines($environmentPath)) {
        $separator = $line.IndexOf('=')
        $name = if ($separator -gt 0) { $line.Substring(0, $separator).Trim() } else { '' }
        if ($name -eq 'ECONOMIC_COMPANY_REGISTRY_PATH') {
            $lines.Add("ECONOMIC_COMPANY_REGISTRY_PATH=$registryPath")
            $seenRegistryPath = $true
        } elseif ($name -in @('ECONOMIC_APP_SECRET_TOKEN','ECONOMIC_AGREEMENT_GRANT_TOKEN','ECONOMIC_EXPECTED_AGREEMENT_NUMBER')) {
            # Remove obsolete plaintext duplicates after the registry was written successfully.
            continue
        } else {
            $lines.Add($line)
        }
    }
    if (-not $seenRegistryPath) { $lines.Add("ECONOMIC_COMPANY_REGISTRY_PATH=$registryPath") }
    try {
        [IO.File]::WriteAllLines($temporaryEnvironmentPath, $lines, [Text.UTF8Encoding]::new($false))
        & icacls.exe $temporaryEnvironmentPath /inheritance:r /grant:r `
            'SYSTEM:F' 'BUILTIN\Administrators:F' 'NT SERVICE\EconomicMcp:R' | Out-Null
        Move-Item -LiteralPath $temporaryEnvironmentPath -Destination $environmentPath -Force
    } finally {
        if (Test-Path -LiteralPath $temporaryEnvironmentPath) {
            Remove-Item -LiteralPath $temporaryEnvironmentPath -Force
        }
    }
}

Test-UserSelector -Values $ReadUserOid
Test-UserSelector -Values $DraftUserOid -AllowEmpty

$appSecret = $null
$agreementGrant = $null
$temporaryPath = Join-Path $configRoot "companies.stage1.$([Guid]::NewGuid().ToString('N')).tmp"
try {
    if ($UseLegacyCredentials) {
        if (Test-Path -LiteralPath $registryPath) {
            throw '-UseLegacyCredentials is allowed only when creating the first registry.'
        }
        $legacy = Read-EnvironmentValues
        $appSecret = [string]$legacy.ECONOMIC_APP_SECRET_TOKEN
        $agreementGrant = [string]$legacy.ECONOMIC_AGREEMENT_GRANT_TOKEN
        if ([string]::IsNullOrWhiteSpace($appSecret) -or [string]::IsNullOrWhiteSpace($agreementGrant)) {
            throw 'Legacy e-conomic credentials were not found in stage1.env.'
        }
        if ($legacy.ECONOMIC_EXPECTED_AGREEMENT_NUMBER -ne $AgreementNumber) {
            throw 'The supplied agreement number does not match the legacy configuration.'
        }
    } else {
        $appSecret = Read-SecretPlainText 'Paste the e-conomic App Secret Token (input is hidden)'
        $agreementGrant = Read-SecretPlainText 'Paste the e-conomic Agreement Grant Token (input is hidden)'
    }

    $registry = if (Test-Path -LiteralPath $registryPath -PathType Leaf) {
        try {
            # The registry is UTF-8 without a BOM. Use an explicit decoder so
            # Windows PowerShell 5.1 cannot reinterpret Danish text as ANSI.
            [IO.File]::ReadAllText(
                $registryPath,
                [Text.UTF8Encoding]::new($false)
            ) | ConvertFrom-Json
        } catch {
            throw 'The existing company registry is not valid JSON.'
        }
    } else {
        [pscustomobject]@{ version = 1; companies = @() }
    }
    if ($registry.version -ne 1 -or $null -eq $registry.companies) {
        throw 'The existing company registry has an unsupported format.'
    }

    $companies = @($registry.companies | Where-Object { $_.companyId -ne $CompanyId })
    if ($companies.Count -ge 100) { throw 'The Stage 1 company limit of 100 has been reached.' }
    if ($companies | Where-Object { [string]$_.agreementNumber -eq $AgreementNumber }) {
        throw 'Another company already uses this e-conomic agreement number.'
    }
    $companies += [ordered]@{
        companyId = $CompanyId
        displayName = $DisplayName.Trim()
        agreementNumber = $AgreementNumber.TrimStart([char]'0')
        enabled = -not $Disabled
        access = [ordered]@{
            readUserOids = @($ReadUserOid | ForEach-Object { $_.ToLowerInvariant() })
            draftUserOids = @($DraftUserOid | ForEach-Object { $_.ToLowerInvariant() })
        }
        credentials = [ordered]@{
            appSecretToken = $appSecret
            agreementGrantToken = $agreementGrant
        }
    }

    $document = [ordered]@{ version = 1; companies = @($companies | Sort-Object companyId) }
    $json = $document | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($temporaryPath, $json, [Text.UTF8Encoding]::new($false))
    & icacls.exe $temporaryPath /inheritance:r /grant:r `
        'SYSTEM:F' 'BUILTIN\Administrators:F' 'NT SERVICE\EconomicMcp:R' | Out-Null
    Move-Item -LiteralPath $temporaryPath -Destination $registryPath -Force
    Set-RegistryEnvironmentPath
    Set-EconomicMcpAcls

    Write-Host "Stored company '$CompanyId' in the protected registry. Token values were not displayed."
    if ($Start) {
        Start-Service -Name $script:EconomicMcpServiceName
        & (Join-Path $script:EconomicMcpInstallRoot 'scripts\windows\healthcheck.ps1') -Retries 12 -RetryDelaySeconds 2
    }
} finally {
    if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
    $appSecret = $null
    $agreementGrant = $null
    $legacy = $null
    $registry = $null
    $companies = $null
    $document = $null
    $json = $null
    [GC]::Collect()
}
