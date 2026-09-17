import { newId, nowIso } from '@mt/utils';
import type { AuditLogEntry } from '@mt/types';
import { getData } from '../data';
import { logger } from '../logger';

export interface AuditInput {
  actor: { id: string; email: string | null };
  action: string;
  targetType: string;
  targetId?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
  ipAddress?: string | null;
}

/**
 * Append-only audit trail for sensitive administrative actions. Metadata is
 * passed through the logger's redaction rules implicitly by keeping it small and
 * non sensitive by construction (ids, counts, fingerprints — never content).
 */
export async function writeAuditLog(input: AuditInput): Promise<AuditLogEntry> {
  const data = await getData();
  const now = nowIso();
  const entry: AuditLogEntry = {
    id: newId('log'),
    actorUid: input.actor.id,
    actorEmail: input.actor.email,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId ?? null,
    metadata: input.metadata ?? {},
    ipAddress: input.ipAddress ?? null,
    createdAt: now,
    updatedAt: now,
  };
  await data.audit.append(entry);
  logger.info('audit', { action: entry.action, actor: entry.actorUid, target: entry.targetId });
  return entry;
}
