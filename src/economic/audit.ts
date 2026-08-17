import { appendFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { redactSecrets } from '../errors.js';

export interface AuditEvent {
  requestId?: string;
  tenantId?: string;
  userOid?: string;
  username?: string;
  role?: string;
  companyId?: string;
  companyDisplayName?: string;
  tool: string;
  action: string;
  serviceId?: string;
  method?: string;
  path?: string;
  operationHash?: string;
  idempotencyKey?: string;
  allowed?: boolean;
  reason?: string;
  status?: string;
  result?: 'success' | 'failure' | 'denied';
  error?: string;
  errorCategory?: string;
  policyResult?: string;
  economicHttpStatus?: number;
  durationMs?: number;
  agreementNumber?: string | number;
  draftNumber?: string | number;
  draftReference?: string | number;
}

export async function writeAuditEvent(event: AuditEvent): Promise<void> {
  const auditPath = process.env.ECONOMIC_AUDIT_LOG;
  if (!auditPath) {
    return;
  }

  const record = {
    timestamp: new Date().toISOString(),
    requestId: event.requestId ?? randomUUID(),
    ...event,
    idempotencyKey: event.idempotencyKey ? hashValue(event.idempotencyKey) : undefined,
    error: event.error ? redactSecrets(event.error) : undefined,
  };

  await appendFile(auditPath, `${JSON.stringify(record)}\n`, 'utf8');
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
