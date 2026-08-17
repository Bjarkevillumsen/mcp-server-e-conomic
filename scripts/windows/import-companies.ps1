[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$CsvPath,
    [char]$Delimiter = ';',
    [string]$ReuseAppSecretFromCompanyId,
    [switch]$ReplaceAll,
    [switch]$RestartService,
    [switch]$SkipEconomicValidation
)

. (Join-Path $PSScriptRoot 'Common.ps1')
Assert-EconomicMcpAdministrator
$dataRoot = Assert-EconomicMcpKnownRoot -Path $script:EconomicMcpDataRoot -Kind Data
$configRoot = Join-Path $dataRoot 'config'
$registryPath = Join-Path $configRoot 'companies.stage1.json'
$resolvedCsvPath = (Resolve-Path -LiteralPath $CsvPath).Path
$service = Get-EconomicMcpService

if (-not (Test-Path -LiteralPath $resolvedCsvPath -PathType Leaf)) {
    throw 'The CSV import path must point to a file.'
}
if ((Get-Item -LiteralPath $resolvedCsvPath).Length -gt 2MB) {
    throw 'The company import CSV cannot exceed 2 MB.'
}
if (-not (Test-Path -LiteralPath $registryPath -PathType Leaf)) {
    throw 'The protected company registry does not exist. Add the first company with set-company.ps1.'
}
if ($service -and $service.Status -ne 'Stopped' -and -not $RestartService) {
    throw 'EconomicMcp is running. Use -RestartService to perform a controlled import and health check.'
}

function Read-SecretPlainText {
    param([Parameter(Mandatory)][string]$Prompt)
    $secure = Read-Host $Prompt -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
        if ([string]::IsNullOrWhiteSpace($plain) -or $plain.Length -gt 8192 -or $plain -match '[\r\n]') {
            throw 'The shared App Secret Token must contain 1-8192 characters without line breaks.'
        }
        return $plain.Trim()
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
}

function ConvertTo-UserSelectors {
    param(
        [AllowEmptyString()][string]$Value,
        [Parameter(Mandatory)][string]$ColumnName,
        [string[]]$Default = @()
    )
    $values = [Collections.Generic.List[string]]::new()
    if ([string]::IsNullOrWhiteSpace($Value)) {
        foreach ($defaultValue in $Default) {
            if (-not [string]::IsNullOrWhiteSpace($defaultValue)) {
                $values.Add($defaultValue.Trim().ToLowerInvariant())
            }
        }
    } else {
        foreach ($part in $Value.Split('|')) {
            $normalizedPart = $part.Trim().ToLowerInvariant()
            if ($normalizedPart) { $values.Add($normalizedPart) }
        }
    }
    $valueCount = $values.Count
    if ($valueCount -gt 500) { throw "$ColumnName cannot contain more than 500 selectors." }
    if ($values -contains '*' -and $valueCount -ne 1) {
        throw "The wildcard must be the only selector in $ColumnName."
    }
    foreach ($selector in $values) {
        if ($selector -ne '*' -and $selector -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') {
            throw "Invalid Entra user object ID in $ColumnName."
        }
    }
    return $values.ToArray()
}

function ConvertTo-EnabledValue {
    param([AllowEmptyString()][string]$Value, [Parameter(Mandatory)][int]$RowNumber)
    $normalized = $Value.Trim().ToLowerInvariant()
    if (-not $normalized -or $normalized -eq 'true') { return $true }
    if ($normalized -eq 'false') { return $false }
    throw "CSV row $RowNumber has an invalid Enabled value; use true or false."
}

function Protect-RegistryFile {
    param([Parameter(Mandatory)][string]$Path)
    & icacls.exe $Path /inheritance:r /grant:r `
        'SYSTEM:F' 'BUILTIN\Administrators:F' 'NT SERVICE\EconomicMcp:R' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Failed to protect the company registry file.' }
}

function Test-EconomicCompanyCredentials {
    param(
        [Parameter(Mandatory)][string]$CompanyId,
        [Parameter(Mandatory)][string]$ExpectedAgreementNumber,
        [Parameter(Mandatory)][string]$AppSecretToken,
        [Parameter(Mandatory)][string]$AgreementGrantToken
    )
    try {
        $context = Invoke-RestMethod -Method Get -Uri 'https://restapi.e-conomic.com/self' -Headers @{
            'X-AppSecretToken' = $AppSecretToken
            'X-AgreementGrantToken' = $AgreementGrantToken
        } -TimeoutSec 30
    } catch {
        $statusCode = 'unavailable'
        if ($_.Exception.Response -and $null -ne $_.Exception.Response.StatusCode) {
            $statusCode = [string][int]$_.Exception.Response.StatusCode
        }
        throw "CompanyId '$CompanyId' (HTTP $statusCode)"
    }
    if ([string]$context.agreementNumber -ne $ExpectedAgreementNumber) {
        throw "e-conomic returned an unexpected agreement number for CompanyId '$CompanyId'."
    }
}

$sharedAppSecret = $null
$registry = $null
$document = $null
$json = $null
$temporaryPath = Join-Path $configRoot "companies.stage1.$([Guid]::NewGuid().ToString('N')).tmp"
$backupPath = Join-Path $configRoot "companies.stage1.$([Guid]::NewGuid().ToString('N')).bak"
$serviceWasRunning = $service -and $service.Status -ne 'Stopped'
$registryReplaced = $false

try {
    try {
        # The registry is deliberately written as UTF-8 without a BOM. Windows
        # PowerShell 5.1 otherwise treats the file as ANSI and turns Danish
        # characters into mojibake on the next read/write cycle.
        $registry = [IO.File]::ReadAllText(
            $registryPath,
            [Text.UTF8Encoding]::new($false)
        ) | ConvertFrom-Json
    } catch {
        throw 'The existing company registry is not valid JSON.'
    }
    if ($registry.version -ne 1 -or $null -eq $registry.companies) {
        throw 'The existing company registry has an unsupported format.'
    }

    if ($ReuseAppSecretFromCompanyId) {
        if ($ReuseAppSecretFromCompanyId -cnotmatch '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$') {
            throw 'ReuseAppSecretFromCompanyId must be a valid lowercase company ID.'
        }
        $sourceCompany = @($registry.companies | Where-Object { $_.companyId -eq $ReuseAppSecretFromCompanyId })
        if ($sourceCompany.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$sourceCompany[0].credentials.appSecretToken)) {
            throw 'The selected source company does not contain a reusable App Secret Token.'
        }
        $sharedAppSecret = ([string]$sourceCompany[0].credentials.appSecretToken).Trim()
    } else {
        $sharedAppSecret = Read-SecretPlainText 'Paste the shared e-conomic App Secret Token (input is hidden)'
    }

    $rows = @(Import-Csv -LiteralPath $resolvedCsvPath -Delimiter $Delimiter -Encoding UTF8)
    if ($rows.Count -lt 1 -or $rows.Count -gt 100) {
        throw 'The CSV must contain between 1 and 100 company rows.'
    }
    $requiredColumns = @('CompanyId','DisplayName','AgreementNumber','AgreementGrantToken')
    $availableColumns = @($rows[0].PSObject.Properties.Name)
    foreach ($column in $requiredColumns) {
        if ($availableColumns -notcontains $column) { throw "The CSV is missing the required $column column." }
    }

    $importedIds = @{}
    $importedAgreements = @{}
    $importedCompanies = [Collections.Generic.List[object]]::new()
    for ($index = 0; $index -lt $rows.Count; $index++) {
        $row = $rows[$index]
        $rowNumber = $index + 2
        $companyId = ([string]$row.CompanyId).Trim()
        $displayName = ([string]$row.DisplayName).Trim()
        $agreementNumber = ([string]$row.AgreementNumber).Trim()
        $agreementGrantToken = ([string]$row.AgreementGrantToken).Trim()

        if ($companyId -cnotmatch '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$') {
            throw "CSV row $rowNumber has an invalid CompanyId."
        }
        if ([string]::IsNullOrWhiteSpace($displayName) -or $displayName.Length -gt 120 -or $displayName -match '[\r\n]') {
            throw "CSV row $rowNumber has an invalid DisplayName."
        }
        if ($agreementNumber -notmatch '^0*[1-9]\d*$') {
            throw "CSV row $rowNumber has an invalid AgreementNumber."
        }
        $agreementNumber = $agreementNumber.TrimStart([char]'0')
        if ([string]::IsNullOrWhiteSpace($agreementGrantToken) -or $agreementGrantToken.Length -gt 8192 -or $agreementGrantToken -match '[\r\n]') {
            throw "CSV row $rowNumber has an invalid AgreementGrantToken."
        }
        if ($importedIds.ContainsKey($companyId)) { throw "The CSV contains duplicate CompanyId '$companyId'." }
        if ($importedAgreements.ContainsKey($agreementNumber)) { throw 'The CSV contains a duplicate AgreementNumber.' }

        $readUserOids = @(ConvertTo-UserSelectors -Value ([string]$row.ReadUserOids) -ColumnName 'ReadUserOids' -Default @('*'))
        if ($readUserOids.Count -eq 0) { throw "CSV row $rowNumber must grant read access to at least one selector." }
        $draftUserOids = @(ConvertTo-UserSelectors -Value ([string]$row.DraftUserOids) -ColumnName 'DraftUserOids')
        $enabled = ConvertTo-EnabledValue -Value ([string]$row.Enabled) -RowNumber $rowNumber

        $importedIds[$companyId] = $true
        $importedAgreements[$agreementNumber] = $true
        $importedCompanies.Add([ordered]@{
            companyId = $companyId
            displayName = $displayName
            agreementNumber = $agreementNumber
            enabled = $enabled
            access = [ordered]@{
                readUserOids = @($readUserOids)
                draftUserOids = @($draftUserOids)
            }
            credentials = [ordered]@{
                appSecretToken = $sharedAppSecret
                agreementGrantToken = $agreementGrantToken
            }
        })
    }

    $companies = if ($ReplaceAll) {
        @($importedCompanies)
    } else {
        @($registry.companies | Where-Object { -not $importedIds.ContainsKey([string]$_.companyId) }) + @($importedCompanies)
    }
    if ($companies.Count -lt 1 -or $companies.Count -gt 100) {
        throw 'The merged company registry must contain between 1 and 100 companies.'
    }
    $finalIds = @{}
    $finalAgreements = @{}
    $enabledCount = 0
    foreach ($company in $companies) {
        $finalCompanyId = [string]$company.companyId
        $finalAgreement = [string]$company.agreementNumber
        if ($finalIds.ContainsKey($finalCompanyId)) { throw 'The merged registry contains a duplicate company ID.' }
        if ($finalAgreements.ContainsKey($finalAgreement)) { throw 'The merged registry contains a duplicate agreement number.' }
        $finalIds[$finalCompanyId] = $true
        $finalAgreements[$finalAgreement] = $true
        if ([bool]$company.enabled) { $enabledCount++ }
    }
    if ($enabledCount -eq 0) { throw 'At least one company must remain enabled.' }

    if (-not $SkipEconomicValidation) {
        $validationIndex = 0
        $validationFailures = [Collections.Generic.List[string]]::new()
        foreach ($company in $importedCompanies) {
            $validationIndex++
            Write-Progress -Activity 'Validating e-conomic companies' `
                -Status "$validationIndex of $($importedCompanies.Count): $($company.companyId)" `
                -PercentComplete (($validationIndex / $importedCompanies.Count) * 100)
            try {
                Test-EconomicCompanyCredentials -CompanyId $company.companyId `
                    -ExpectedAgreementNumber $company.agreementNumber `
                    -AppSecretToken $company.credentials.appSecretToken `
                    -AgreementGrantToken $company.credentials.agreementGrantToken
            } catch {
                $validationFailures.Add($_.Exception.Message)
            }
        }
        Write-Progress -Activity 'Validating e-conomic companies' -Completed
        if ($validationFailures.Count -gt 0) {
            throw "e-conomic rejected $($validationFailures.Count) company row(s); registry unchanged: $($validationFailures -join '; ')"
        }
    }

    $document = [ordered]@{ version = 1; companies = @($companies | Sort-Object companyId) }
    $json = $document | ConvertTo-Json -Depth 8
    [IO.File]::WriteAllText($temporaryPath, $json, [Text.UTF8Encoding]::new($false))
    Protect-RegistryFile -Path $temporaryPath

    if ($serviceWasRunning) { Stop-EconomicMcpService }
    [IO.File]::Replace($temporaryPath, $registryPath, $backupPath, $true)
    $registryReplaced = $true
    Protect-RegistryFile -Path $registryPath
    Protect-RegistryFile -Path $backupPath
    Set-EconomicMcpAcls

    if ($RestartService) {
        Start-Service -Name $script:EconomicMcpServiceName
        & (Join-Path $script:EconomicMcpInstallRoot 'scripts\windows\healthcheck.ps1') -Retries 12 -RetryDelaySeconds 2
    }
    Remove-Item -LiteralPath $backupPath -Force
    $registryReplaced = $false

    Write-Host "Imported $($importedCompanies.Count) companies. The protected registry now contains $($companies.Count) companies."
    Write-Warning 'The source CSV still contains Agreement Grant Tokens. Remove it from staging after verification.'
} catch {
    $failure = $_
    if ($registryReplaced -and (Test-Path -LiteralPath $backupPath -PathType Leaf)) {
        Stop-EconomicMcpService
        [IO.File]::Replace($backupPath, $registryPath, $null, $true)
        Protect-RegistryFile -Path $registryPath
        Set-EconomicMcpAcls
    }
    $currentService = Get-EconomicMcpService
    if ($serviceWasRunning -and $currentService -and $currentService.Status -eq 'Stopped') {
        Start-Service -Name $script:EconomicMcpServiceName
    }
    throw $failure
} finally {
    if (Test-Path -LiteralPath $temporaryPath) { Remove-Item -LiteralPath $temporaryPath -Force }
    if (Test-Path -LiteralPath $backupPath) { Remove-Item -LiteralPath $backupPath -Force }
    $sharedAppSecret = $null
    $sourceCompany = $null
    $registry = $null
    $document = $null
    $json = $null
    $rows = $null
    $companies = $null
    [GC]::Collect()
}
