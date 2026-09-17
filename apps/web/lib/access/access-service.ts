import { AppError } from '@mt/domain';
import {
  ACCESS_CHALLENGE_TTL_MS,
  ACCESS_SESSION_TTL_MS,
  SECRET_CODE_MAX_LENGTH,
  type AccessChallenge,
  type AccessChallengeStatus,
  type AccessSession,
} from '@mt/types';
import {
  computeSecretCodeDigest,
  matchesSubmittedDigest,
  normalizeSecretCode,
  signToken,
  verifyToken,
} from '@mt/domain';
import { saltedDigest, nowIso, sha256Hex } from '@mt/utils';
import { env } from '../env';
import { getData, type AccessConfigRecord } from '../data';
import { logger } from '../logger';
import { writeAuditLog } from '../security/audit';
import { enforceRateLimit } from '../security/rate-limit';

const CHALLENGE_AUDIENCE = 'access-challenge';
const SESSION_AUDIENCE = 'access-session';

/**
 * Creates the access configuration on first boot so a fresh deployment is usable
 * before an administrator has visited the panel. The bootstrap code comes from
 * `SEED_SECRET_CODE` and the admin panel makes it obvious that it must be
 * changed (docs/security.md).
 */
export async function ensureAccessConfig(): Promise<AccessConfigRecord> {
  const data = await getData();
  const config = await data.config.getAccessConfig();
  if (config.code) return config;
  const seed = normalizeSecretCode(env().SEED_SECRET_CODE);
  const digest = await computeSecretCodeDigest(seed);
  const fingerprint = await saltedDigest(config.salt, seed);
  const created = await data.config.setAccessConfig({
    code: seed,
    digest,
    maxLength: SECRET_CODE_MAX_LENGTH,
    caseSensitive: true,
    epoch: 1,
    updatedAt: nowIso(),
    updatedBy: 'system',
  });
  logger.warn('access.seed_code_applied', { fingerprint: fingerprint.slice(0, 8) });
  return created;
}

export async function getAccessStatus(): Promise<AccessChallengeStatus> {
  const config = await ensureAccessConfig();
  return {
    epoch: config.epoch,
    maxLength: config.maxLength,
    caseSensitive: config.caseSensitive,
    configured: Boolean(config.code),
  };
}

/**
 * Starts a typing-game session: the browser receives the current secret code so
 * it can match keystrokes locally.
 *
 * Accepted trade-off (ARCHITECTURE.md §6): the code is readable by anyone who
 * inspects the bundle. It is therefore never treated as an authorisation
 * decision — it only gates which UI is shown. All data access is authorised
 * separately by `requireAccess` + `requireUser`.
 */
export async function createChallenge(options: { request?: Request; userId?: string } = {}): Promise<AccessChallenge> {
  const config = await ensureAccessConfig();
  if (options.request) {
    await enforceRateLimit(options.request, 'access:challenge', { limit: 20, windowMs: 60_000 });
  }
  const signed = await signToken(
    env().APP_SECRET,
    { aud: CHALLENGE_AUDIENCE, sub: options.userId ?? undefined, epoch: config.epoch },
    ACCESS_CHALLENGE_TTL_MS,
  );
  return {
    epoch: config.epoch,
    maxLength: config.maxLength,
    caseSensitive: config.caseSensitive,
    code: config.code,
    digestAlgorithm: 'sha-256',
    challengeToken: signed.token,
    expiresAt: signed.expiresAt,
    sessionTtlMs: ACCESS_SESSION_TTL_MS,
  };
}

export interface UnlockOutcome {
  unlocked: boolean;
  token: string;
  expiresAt: string;
  epoch: number;
}

/**
 * Exchanges a valid challenge token plus the SHA-256 digest of the typed code
 * for a signed access session. The plaintext code is never sent back, so it does
 * not appear in request logs.
 */
export async function unlock(input: {
  challengeToken: string;
  digest: string;
  userId?: string;
  ipAddress?: string | null;
}): Promise<UnlockOutcome> {
  const claims = await verifyToken<{ aud: string; sub?: string; epoch: number }>(
    env().APP_SECRET,
    input.challengeToken,
    { audience: CHALLENGE_AUDIENCE },
  );
  if (!claims) throw AppError.precondition('the access challenge expired, restart the game');

  const config = await ensureAccessConfig();
  if (claims.epoch !== config.epoch) {
    throw AppError.precondition('the access challenge is no longer valid');
  }
  await consumeChallengeNonce(input.challengeToken);

  const matched = await matchesSubmittedDigest(config.code, input.digest);
  if (!matched) {
    logger.warn('access.unlock_rejected', { reason: 'digest_mismatch' });
    return { unlocked: false, token: '', expiresAt: nowIso(), epoch: config.epoch };
  }

  const data = await getData();
  await data.config.incrementUnlockCount();
  const signed = await signToken(
    env().APP_SECRET,
    { aud: SESSION_AUDIENCE, sub: input.userId, epoch: config.epoch },
    ACCESS_SESSION_TTL_MS,
  );
  logger.info('access.unlocked', { epoch: config.epoch, authenticated: Boolean(input.userId) });
  return { unlocked: true, token: signed.token, expiresAt: signed.expiresAt, epoch: config.epoch };
}

/**
 * Single-use challenge tokens.
 *
 * A signed token is only proof that a challenge was issued; without this a
 * captured token could be replayed for as long as it is valid. The nonce store
 * reuses the rate-limit repository with a limit of one and a window equal to the
 * challenge TTL, so entries expire on their own.
 */
async function consumeChallengeNonce(challengeToken: string): Promise<void> {
  const data = await getData();
  const key = `access:challenge-nonce:${await sha256Hex(challengeToken)}`;
  const result = await data.rateLimits.consume(key, { limit: 1, windowMs: ACCESS_CHALLENGE_TTL_MS });
  if (!result.allowed) {
    throw AppError.precondition('the access challenge expired, restart the game');
  }
}

export async function verifyAccessSession(token: string | null | undefined): Promise<AccessSession | null> {
  if (!token) return null;
  const claims = await verifyToken<{ aud: string; sub?: string; epoch: number; exp: number }>(
    env().APP_SECRET,
    token,
    { audience: SESSION_AUDIENCE },
  );
  if (!claims) return null;
  return {
    epoch: claims.epoch,
    userId: claims.sub ?? null,
    issuedAt: new Date(claims.exp - ACCESS_SESSION_TTL_MS).toISOString(),
    expiresAt: new Date(claims.exp).toISOString(),
  };
}

/** Re-issues an access session bound to a now-authenticated user. */
export async function issueSessionForUser(userId: string, epoch: number): Promise<UnlockOutcome> {
  const signed = await signToken(
    env().APP_SECRET,
    { aud: SESSION_AUDIENCE, sub: userId, epoch },
    ACCESS_SESSION_TTL_MS,
  );
  return { unlocked: true, token: signed.token, expiresAt: signed.expiresAt, epoch };
}

/**
 * Changes the secret code. `rotate` (default) bumps the epoch, which instantly
 * invalidates every outstanding access session and challenge.
 */
export async function changeSecretCode(input: {
  code: string;
  strategy: 'rotate' | 'replace';
  actor: { id: string; email: string };
  ipAddress?: string | null;
}): Promise<AccessConfigRecord> {
  const data = await getData();
  const config = await ensureAccessConfig();
  const code = normalizeSecretCode(input.code);
  const digest = await computeSecretCodeDigest(code);
  const epoch = input.strategy === 'rotate' ? config.epoch + 1 : config.epoch;
  const updated = await data.config.setAccessConfig({
    code,
    digest,
    epoch,
    unlockCount: input.strategy === 'rotate' ? 0 : config.unlockCount,
    updatedAt: nowIso(),
    updatedBy: input.actor.id,
  });
  const fingerprint = await saltedDigest(config.salt, code);
  await writeAuditLog({
    actor: input.actor,
    action: 'secret_code.changed',
    targetType: 'appConfig/access',
    targetId: 'access',
    ipAddress: input.ipAddress ?? null,
    metadata: {
      strategy: input.strategy,
      epoch,
      length: code.length,
      // Only a non reversible fingerprint is logged, never the code itself.
      fingerprint: fingerprint.slice(0, 12),
    },
  });
  logger.info('access.secret_code_changed', { epoch, strategy: input.strategy });
  return updated;
}