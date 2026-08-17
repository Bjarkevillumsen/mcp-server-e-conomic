import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EconomicClient, type EconomicClientOptions } from '../economic/client.js';
import {
  Stage1CompanyRegistry,
  legacyStage1Company,
  type Stage1CompanyConfig,
} from './companies.js';
import { registerStage1Tools, type RegisterStage1ToolsOptions } from './tools.js';

export interface CreateStage1ServerOptions extends RegisterStage1ToolsOptions {
  client?: EconomicClient;
  clientOptions?: EconomicClientOptions;
  companyRegistry?: Stage1CompanyRegistry;
  companies?: readonly Stage1CompanyConfig[];
  /** Compatibility input for local acceptance tests using one injected client. */
  expectedAgreementNumber?: string | number;
}

export function createStage1Server(options: CreateStage1ServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'e-conomic-stage1',
    version: '0.3.2',
  });
  const companyRegistry = options.companyRegistry ?? createCompanyRegistry(options);
  registerStage1Tools(server, companyRegistry, options);
  return server;
}

function createCompanyRegistry(options: CreateStage1ServerOptions): Stage1CompanyRegistry {
  if (options.companies) {
    return new Stage1CompanyRegistry(options.companies, options.clientOptions);
  }

  const legacy = legacyStage1Company({
    ...process.env,
    ...(options.expectedAgreementNumber !== undefined
      ? { ECONOMIC_EXPECTED_AGREEMENT_NUMBER: String(options.expectedAgreementNumber) }
      : {}),
    ...(options.client
      ? {
          ECONOMIC_APP_SECRET_TOKEN: 'provided-by-injected-client',
          ECONOMIC_AGREEMENT_GRANT_TOKEN: 'provided-by-injected-client',
        }
      : {}),
  });
  return new Stage1CompanyRegistry([legacy], {
    ...options.clientOptions,
    ...(options.client ? { clientFactory: () => options.client as EconomicClient } : {}),
  });
}
