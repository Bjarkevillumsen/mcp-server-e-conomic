import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EconomicClient, type EconomicClientOptions } from '../economic/client.js';
import { registerStage1Tools, type RegisterStage1ToolsOptions } from './tools.js';

export interface CreateStage1ServerOptions extends RegisterStage1ToolsOptions {
  client?: EconomicClient;
  clientOptions?: EconomicClientOptions;
}

export function createStage1Server(options: CreateStage1ServerOptions = {}): McpServer {
  const server = new McpServer({
    name: 'e-conomic-stage1',
    version: '0.1.0',
  });
  const client = options.client ?? new EconomicClient(options.clientOptions);
  registerStage1Tools(server, client, options);
  return server;
}
