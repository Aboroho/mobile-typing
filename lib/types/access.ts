import type { Timestamp } from './common';

/**
 * Delivered to the browser at the start of a typing-game session so the secret
 * code can be matched locally. This is an accepted product trade-off — see
 * docs/security.md. The server never trusts the client unlock flag: every
 * protected operation additionally requires an access session issued by
 * `POST /api/v1/access/unlock` and bound to `epoch`.
 */
export interface AccessChallenge {
  /** Incremented on every secret-code rotation; invalidates older sessions. */
  epoch: number;
  maxLength: number;
  caseSensitive: boolean;
  /** Plaintext secret code. Never rendered, never logged. */
  code: string;
  digestAlgorithm: 'sha-256';
  /** Signed, short lived token that must be presented to unlock. */
  challengeToken: string;
  expiresAt: Timestamp;
  /** Milliseconds a granted access session stays valid. */
  sessionTtlMs: number;
}

export interface AccessChallengeStatus {
  epoch: number;
  maxLength: number;
  caseSensitive: boolean;
  /** True when an administrator has configured a code. */
  configured: boolean;
}

export interface AccessSession {
  epoch: number;
  issuedAt: Timestamp;
  expiresAt: Timestamp;
  userId: string | null;
}

export interface AccessLockResult {
  locked: boolean;
}
