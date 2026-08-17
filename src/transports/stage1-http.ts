import { randomUUID } from 'node:crypto';
import {
  createServer as createNodeServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { HttpRequestError, readJsonBody } from './http-helpers.js';
import {
  AuthenticationError,
  AuthorizationError,
  authorizeStage1Principal,
  createEntraTokenValidator,
  makeToolAuthorizer,
  type EntraPrincipal,
  type EntraTokenValidator,
} from '../stage1/auth.js';
import {
  createProtectedResourceMetadata,
  entraAuthorizationScope,
} from '../stage1/oauth-metadata.js';
import { createStage1Server } from '../stage1/server.js';
import { Stage1TechnicalLogger } from '../stage1/logging.js';
import {
  Stage1CompanyRegistry,
  type Stage1CompanyClientFactory,
} from '../stage1/companies.js';
import type { Stage1StartupConfig } from '../stage1/startup.js';

export interface CreateStage1HttpServerOptions {
  config: Stage1StartupConfig;
  tokenValidator?: EntraTokenValidator;
  logger?: Stage1TechnicalLogger;
  clientFactory?: Stage1CompanyClientFactory;
}

export function createStage1HttpServer(options: CreateStage1HttpServerOptions) {
  const { config } = options;
  const tokenValidator = options.tokenValidator ?? createEntraTokenValidator(config.entra);
  const logger = options.logger ?? new Stage1TechnicalLogger();
  const companyRegistry = new Stage1CompanyRegistry(config.companies, {
    timeoutMs: config.requestTimeoutMs,
    ...(options.clientFactory ? { clientFactory: options.clientFactory } : {}),
  });

  const httpServer = createNodeServer(async (req, res) => {
    const requestId = requestIdFor(req);
    const startedAt = Date.now();
    let principal: EntraPrincipal | undefined;
    res.setHeader('X-Request-Id', requestId);

    try {
      const path = requestPath(req);
      if (path === '/healthz') {
        if (req.method !== 'GET') throw new HttpRequestError(405, 'Method not allowed');
        sendJson(res, 200, { status: 'ok' }, config);
        return;
      }

      if (
        path === '/.well-known/oauth-protected-resource' ||
        path === '/.well-known/oauth-protected-resource/mcp'
      ) {
        if (req.method !== 'GET') throw new HttpRequestError(405, 'Method not allowed');
        sendJson(
          res,
          200,
          createProtectedResourceMetadata(config.entra, config.publicBaseUrl),
          config,
        );
        return;
      }

      assertAllowedOrigin(req, config);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, corsHeaders(req, config));
        res.end();
        return;
      }
      if (path !== '/mcp') throw new HttpRequestError(404, 'Not found');
      if (req.method !== 'POST') throw new HttpRequestError(405, 'Method not allowed');
      assertJsonContentType(req);

      principal = await tokenValidator.validateAuthorizationHeader(req.headers.authorization);
      authorizeStage1Principal(principal, undefined, config.entra.requiredScope);

      const body = await readJsonBody(req, config.maxBodyBytes);
      assertMcpRequest(body);
      const toolName = requestedToolName(body);
      if (toolName) {
        // Pre-dispatch authorization produces HTTP 403. The same check is also
        // installed inside every registered Stage 1 tool callback below.
        authorizeStage1Principal(principal, toolName, config.entra.requiredScope);
      }

      const mcpServer = createStage1Server({
        companyRegistry,
        authorize: makeToolAuthorizer(principal, config.entra.requiredScope),
        requestContext: { requestId, principal },
        logger,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);

      res.on('close', () => {
        void transport.close();
        void mcpServer.close();
      });

      if (!toolName) {
        logger.log({
          requestId,
          principal,
          operationCategory: 'http',
          policyResult: 'not_applicable',
          httpStatus: res.statusCode,
          durationMs: Date.now() - startedAt,
        });
      }
    } catch (error) {
      const status = statusForError(error);
      logger.log({
        requestId,
        principal,
        operationCategory: status === 401 ? 'authentication' : status === 403 ? 'authorization' : 'http',
        policyResult: status === 403 ? 'denied' : 'not_applicable',
        httpStatus: status,
        durationMs: Date.now() - startedAt,
        error,
      });

      if (!res.headersSent) {
        const headers = status === 401 ? wwwAuthenticateHeaders(config) : undefined;
        sendJson(
          res,
          status,
          { error: publicErrorMessage(status) },
          config,
          req,
          headers,
        );
      } else {
        res.destroy();
      }
    }
  });

  httpServer.requestTimeout = config.requestTimeoutMs;
  httpServer.headersTimeout = Math.min(config.requestTimeoutMs, 60_000);
  httpServer.keepAliveTimeout = 5_000;
  httpServer.on('clientError', (_error, socket) => {
    if (socket.writable) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    }
  });

  return httpServer;
}

function requestPath(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
  } catch {
    throw new HttpRequestError(400, 'Malformed request URL');
  }
}

function assertJsonContentType(req: IncomingMessage): void {
  const contentType = req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new HttpRequestError(415, 'Content-Type must be application/json');
  }
}

function assertAllowedOrigin(req: IncomingMessage, config: Stage1StartupConfig): void {
  const origin = req.headers.origin;
  if (origin && !config.allowedOrigins.includes(origin)) {
    throw new HttpRequestError(403, 'Origin not allowed');
  }
}

function assertMcpRequest(body: unknown): asserts body is Record<string, unknown> {
  if (!isRecord(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    throw new HttpRequestError(400, 'Malformed MCP request');
  }
  if ('params' in body && body.params !== undefined && !isRecord(body.params)) {
    throw new HttpRequestError(400, 'Malformed MCP request parameters');
  }
}

function requestedToolName(body: Record<string, unknown>): string | undefined {
  if (body.method !== 'tools/call') return undefined;
  if (!isRecord(body.params) || typeof body.params.name !== 'string') {
    throw new HttpRequestError(400, 'Malformed MCP tool call');
  }
  return body.params.name;
}

function requestIdFor(req: IncomingMessage): string {
  const supplied = req.headers['x-request-id'];
  if (typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)) {
    return supplied;
  }
  return randomUUID();
}

function statusForError(error: unknown): number {
  if (error instanceof AuthenticationError) return 401;
  if (error instanceof AuthorizationError) return 403;
  if (error instanceof HttpRequestError) return error.status;
  if (error instanceof SyntaxError) return 400;
  return 500;
}

function publicErrorMessage(status: number): string {
  if (status === 401) return 'Unauthorized';
  if (status === 403) return 'Forbidden';
  if (status === 404) return 'Not found';
  if (status === 405) return 'Method not allowed';
  if (status === 413) return 'Payload too large';
  if (status === 415) return 'Unsupported media type';
  if (status >= 500) return 'Internal server error';
  return 'Bad request';
}

function wwwAuthenticateHeaders(config: Stage1StartupConfig): Record<string, string> {
  const metadataUrl = config.publicBaseUrl
    ? `${config.publicBaseUrl}/.well-known/oauth-protected-resource`
    : undefined;
  return {
    'WWW-Authenticate': metadataUrl
      ? `Bearer realm="EconomicMcp", resource_metadata="${metadataUrl}", scope="${entraAuthorizationScope(config.entra, config.publicBaseUrl)}"`
      : 'Bearer realm="EconomicMcp"',
  };
}

function corsHeaders(
  req: IncomingMessage | undefined,
  config: Stage1StartupConfig,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version, X-Request-Id',
    Vary: 'Origin',
  };
  const origin = req?.headers.origin;
  if (origin && config.allowedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  config: Stage1StartupConfig,
  req?: IncomingMessage,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...corsHeaders(req, config),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
