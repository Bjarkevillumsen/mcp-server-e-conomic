import { entraIssuer, type EntraConfig } from './auth.js';

export interface OAuthProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: ['header'];
}

export function createProtectedResourceMetadata(
  config: EntraConfig,
  publicBaseUrl?: string,
): OAuthProtectedResourceMetadata {
  return {
    resource: normalizeResource(publicBaseUrl, config.apiClientId),
    authorization_servers: [entraIssuer(config.tenantId)],
    // Entra expects custom API permissions in OAuth requests as the complete
    // Application-ID-URI-qualified scope. The access token's `scp` claim still
    // contains the short scope name checked by the authorization layer.
    scopes_supported: [entraAuthorizationScope(config)],
    bearer_methods_supported: ['header'],
  };
}

export function entraAuthorizationScope(config: EntraConfig): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(config.requiredScope)) {
    return config.requiredScope;
  }
  return `api://${config.apiClientId}/${config.requiredScope}`;
}

function normalizeResource(publicBaseUrl: string | undefined, clientId: string): string {
  if (!publicBaseUrl) {
    return `api://${clientId}`;
  }

  const parsed = new URL(publicBaseUrl);
  if (parsed.protocol !== 'https:') {
    throw new Error('MCP_PUBLIC_BASE_URL must use HTTPS.');
  }
  parsed.pathname = parsed.pathname.replace(/\/$/, '');
  parsed.search = '';
  parsed.hash = '';
  return `${parsed.toString().replace(/\/$/, '')}/mcp`;
}
