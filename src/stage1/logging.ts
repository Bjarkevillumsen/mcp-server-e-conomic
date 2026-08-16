import { EconomicHttpError, formatUnknownError, redactSecrets } from '../errors.js';
import type { EntraPrincipal } from './auth.js';
import { primaryEconomicRole } from './auth.js';
import { isStage1WriteTool, type Stage1ToolName } from './allowlist.js';

export interface Stage1RequestContext {
  requestId: string;
  principal?: EntraPrincipal;
}

export interface Stage1TechnicalLogEvent {
  requestId: string;
  principal?: EntraPrincipal;
  tool?: Stage1ToolName;
  operationCategory: 'http' | 'read' | 'draft_write' | 'authentication' | 'authorization';
  policyResult?: 'allowed' | 'denied' | 'not_applicable';
  economicHttpStatus?: number;
  httpStatus?: number;
  durationMs: number;
  error?: unknown;
  draftNumber?: string | number;
  draftReference?: string | number;
}

export type Stage1LogSink = (line: string) => void;

export class Stage1TechnicalLogger {
  constructor(private readonly sink: Stage1LogSink = line => console.error(line)) {}

  log(event: Stage1TechnicalLogEvent): void {
    const error = event.error === undefined ? undefined : formatUnknownError(event.error);
    const record = {
      timestamp: new Date().toISOString(),
      requestId: safeText(event.requestId),
      tenantId: event.principal?.tenantId,
      userOid: event.principal?.userOid,
      username: event.principal?.username ? safeText(event.principal.username) : undefined,
      role: event.principal ? primaryEconomicRole(event.principal) : undefined,
      tool: event.tool,
      operationCategory: event.operationCategory,
      policyResult: event.policyResult,
      economicHttpStatus: event.economicHttpStatus,
      httpStatus: event.httpStatus,
      durationMs: Math.max(0, Math.round(event.durationMs)),
      errorCategory: error ? categorizeError(event.error) : undefined,
      error: error ? safeText(error) : undefined,
      draftNumber: event.draftNumber,
      draftReference: event.draftReference ? safeText(String(event.draftReference)) : undefined,
    };

    this.sink(JSON.stringify(record));
  }
}

export function operationCategory(tool: Stage1ToolName): 'read' | 'draft_write' {
  return isStage1WriteTool(tool) ? 'draft_write' : 'read';
}

export function economicStatusForResult(tool: Stage1ToolName): number {
  return isStage1WriteTool(tool) ? 201 : 200;
}

export function categorizeError(error: unknown): string {
  if (error instanceof EconomicHttpError) return `economic_http_${error.status}`;
  if (error instanceof Error && /agreement/i.test(error.message)) return 'agreement_validation';
  if (error instanceof Error && /policy|blocked/i.test(error.message)) return 'policy_denied';
  if (error instanceof Error && error.name === 'AuthenticationError') return 'authentication';
  if (error instanceof Error && error.name === 'AuthorizationError') return 'authorization';
  return 'application_error';
}

function safeText(value: string): string {
  return redactSecrets(value).replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]');
}
