import type { AuditLogEntry } from '@mt/types';
import type { AccessConfigRecord, UserRecord } from '../data/types';

/**
 * Re-exports kept in one module so `serialize.ts` stays free of cycles with the
 * data layer while still typing Firestore documents precisely.
 */
export type { AccessConfigRecord, UserRecord };
export type AuditLogEntryAlias = AuditLogEntry;
