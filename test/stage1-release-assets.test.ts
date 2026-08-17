import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const requiredAssets = [
  'config/stage1.env.example',
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
    expect(example).toContain('ECONOMIC_EXPECTED_AGREEMENT_NUMBER=1382005');
    expect(example).toContain('ECONOMIC_ENABLE_BOOKING=false');
    expect(example).toMatch(/^ENTRA_TENANT_ID=$/m);
    expect(example).toMatch(/^ENTRA_API_CLIENT_ID=$/m);
    expect(example).toMatch(/^ECONOMIC_APP_SECRET_TOKEN=$/m);
    expect(example).toMatch(/^ECONOMIC_AGREEMENT_GRANT_TOKEN=$/m);
  });

  it('keeps normal CI free of live acceptance commands', () => {
    const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
    expect(ci).toContain('npm audit --omit=dev');
    expect(ci).toContain('scripts/build-release.ps1');
    expect(ci).not.toContain('acceptance:stage1');
    expect(ci).not.toContain('ECONOMIC_ALLOW_LIVE_WRITE_TESTS');
  });

  it('keeps the Caddy origin loopback-only and the admin endpoint local', () => {
    const caddyfile = readFileSync('config/Caddyfile.example', 'utf8');
    expect(caddyfile).toContain('reverse_proxy 127.0.0.1:3000');
    expect(caddyfile).toContain('admin 127.0.0.1:2019');
    expect(caddyfile).toContain('auto_https disable_redirects');
    expect(caddyfile).not.toContain('log_credentials');
  });
});
