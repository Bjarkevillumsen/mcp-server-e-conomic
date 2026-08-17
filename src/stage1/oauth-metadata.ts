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
  const resource = normalizeResource(publicBaseUrl, config.apiClientId);
  return {
    // Claude uses the MCP endpoint itself as OAuth's `resource` parameter.
    // Registering this exact HTTPS value as the Entra Application ID URI keeps
    // the resource indicator and scope prefix aligned during token exchange.
    resource,
    authorization_servers: [entraIssuer(config.tenantId)],
    scopes_supported: [entraAuthorizationScope(config, publicBaseUrl)],
    bearer_methods_supported: ['header'],
  };
}

export function entraAuthorizationScope(config: EntraConfig, publicBaseUrl?: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(config.requiredScope)) {
    return config.requiredScope;
  }
  return `${normalizeResource(publicBaseUrl, config.apiClientId)}/${config.requiredScope}`;
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
