import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const requiredAssets = [
  'config/stage1.env.example',
  'config/companies.stage1.example.json',
  'config/companies-import.example.csv',
  'config/cloudflared-ingress.example.yml',
  'config/Caddyfile.example',
  'service/EconomicMcpService.xml',
  'service/CaddyService.xml',
  'service/start-service.ps1',
  'service/WinSW-LICENSE.txt',
  'scripts/build-release.ps1',
  'scripts/windows/install.ps1',
  'scripts/windows/update.ps1',
  'scripts/windows/rollback.ps1',
  'scripts/windows/uninstall.ps1',
  'scripts/windows/healthcheck.ps1',
  'scripts/windows/healthcheck-caddy.ps1',
  'scripts/windows/install-caddy.ps1',
  'scripts/windows/uninstall-caddy.ps1',
  'scripts/windows/test-economic.ps1',
  'scripts/windows/test-entra.ps1',
  'scripts/windows/set-company.ps1',
  'scripts/windows/import-companies.ps1',
  'scripts/windows/readiness-check.ps1',
  'docs/ARCHITECTURE.md',
  'docs/NETWORK-DESIGN.md',
  'docs/ENTRA-ID-SETUP.md',
  'docs/CLOUDFLARE-TUNNEL.md',
  'docs/CADDY-WINDOWS.md',
  'docs/SECURITY.md',
  'docs/THREAT-MODEL.md',
  'docs/WINDOWS-DEPLOYMENT.md',
  'docs/OPERATIONS-RUNBOOK.md',
  'docs/LIVE-ACCEPTANCE-TEST.md',
] as const;

describe('Stage 1 release assets', () => {
  it.each(requiredAssets)('includes %s', path => {
    expect(() => readFileSync(path)).not.toThrow();
  });

  it('keeps the committed environment file placeholder-only and localhost-bound', () => {
    const example = readFileSync('config/stage1.env.example', 'utf8');
    expect(example).toContain('MCP_HTTP_HOST=127.0.0.1');
    expect(example).toContain('ECONOMIC_COMPANY_REGISTRY_PATH=C:\\ProgramData\\EconomicMcp\\config\\companies.stage1.json');
    expect(example).toContain('ECONOMIC_ENABLE_BOOKING=false');
    expect(example).toMatch(/^ENTRA_TENANT_ID=$/m);
    expect(example).toMatch(/^ENTRA_API_CLIENT_ID=$/m);
    expect(example).not.toMatch(/^ECONOMIC_APP_SECRET_TOKEN=/m);
    expect(example).not.toMatch(/^ECONOMIC_AGREEMENT_GRANT_TOKEN=/m);
    const companies = readFileSync('config/companies.stage1.example.json', 'utf8');
    expect(companies).toContain('REPLACE_WITH_APP_SECRET_TOKEN');
    expect(companies).toContain('REPLACE_WITH_AGREEMENT_GRANT_TOKEN');
  });

  it('keeps normal CI free of live acceptance commands', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain('npm audit --omit=dev');
    expect(ci).toContain('scripts/build-release.ps1');
    expect(ci).not.toContain('acceptance:stage1');
    expect(ci).not.toContain('ECONOMIC_ALLOW_LIVE_WRITE_TESTS');
  });

  it('monitors the production endpoint from outside the Windows host', () => {
    const monitor = readFileSync('.github/workflows/production-monitor.yml', 'utf8');
    expect(monitor).toContain('https://mcp.squaremeter.dk');
    expect(monitor).toContain("cron: '*/15 * * * *'");
    expect(monitor).toContain("test \"$auth_status\" = '401'");
    expect(monitor).toContain("test \"$cors_status\" = '403'");
    expect(monitor).toContain('strict-transport-security');
    expect(monitor).toContain('x-content-type-options');
  });

  it('bulk-imports companies with one shared app secret and no secret output', () => {
    const importer = readFileSync('scripts/windows/import-companies.ps1', 'utf8');
    expect(importer).toContain('[string]$ReuseAppSecretFromCompanyId');
    expect(importer).toContain('Read-Host $Prompt -AsSecureString');
    expect(importer).toContain('[IO.File]::Replace($temporaryPath, $registryPath, $backupPath, $true)');
    expect(importer).toContain('Test-EconomicCompanyCredentials');
    expect(importer).toContain('The source CSV still contains Agreement Grant Tokens');
    expect(importer).not.toContain('Write-Host $sharedAppSecret');
    expect(importer).not.toContain('Write-Host $agreementGrantToken');
  });

  it('reads existing company registries explicitly as UTF-8 in Windows PowerShell', () => {
    for (const path of ['scripts/windows/import-companies.ps1', 'scripts/windows/set-company.ps1']) {
      const script = readFileSync(path, 'utf8');
      expect(script).toMatch(/\[IO\.File\]::ReadAllText\(\s*\$registryPath,\s*\[Text\.UTF8Encoding\]::new\(\$false\)\s*\)/);
      expect(script).not.toMatch(/Get-Content\s+-LiteralPath\s+\$registryPath\s+-Raw\s+\|\s+ConvertFrom-Json/);
    }
  });

  it('migrates and rolls back the two v0.3 policy capability names during update', () => {
    const updater = readFileSync('scripts/windows/update.ps1', 'utf8');
    expect(updater).toContain("'stage1_create_sales_invoice_draft' = 'economic_create_sales_invoice_draft'");
    expect(updater).toContain("'stage1_create_journal_draft_entry' = 'economic_create_journal_draft_entry'");
    expect(updater).toContain('Update-Stage1V030PolicyNames -Path $policyPath');
    expect(updater).toContain('Copy-Item -LiteralPath $policyPath -Destination (Join-Path $backupRoot $policyBackupName)');
    expect(updater).toContain('Copy-Item -LiteralPath $policyBackup -Destination $policyPath');
    const common = readFileSync('scripts/windows/Common.ps1', 'utf8');
    expect(common).toContain("Join-Path $backupRoot 'economic-policy.stage1.json'");
    expect(common).toContain("Join-Path $resolvedBackup 'economic-policy.stage1.json'");
  });

  it('keeps the Caddy origin loopback-only and the admin endpoint local', () => {
    const caddyfile = readFileSync('config/Caddyfile.example', 'utf8');
    expect(caddyfile).toContain('reverse_proxy 127.0.0.1:3000');
    expect(caddyfile).toContain('admin 127.0.0.1:2019');
    expect(caddyfile).toContain('auto_https disable_redirects');
    expect(caddyfile).toContain('Strict-Transport-Security "max-age=31536000"');
    expect(caddyfile).toContain('X-Content-Type-Options "nosniff"');
    expect(caddyfile).not.toContain('log_credentials');
  });

  it('sets an explicit protected ACL on the generated Caddyfile', () => {
    const installer = readFileSync('scripts/windows/install-caddy.ps1', 'utf8');
    expect(installer).toContain('icacls.exe $targetCaddyfile /inheritance:r');
    expect(installer).toContain("'BUILTIN\\Administrators:F'");
    expect(installer).toContain('"${serviceIdentity}:R"');
  });
});
