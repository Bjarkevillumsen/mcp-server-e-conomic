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
    scopes_supported: [config.requiredScope],
    bearer_methods_supported: ['header'],
  };
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
  return parsed.toString().replace(/\/$/, '');
}
