/**
 * Cross-cutting product limits. They live in the types package so that both the
 * validation layer (client + server input checks) and the domain layer
 * (authorisation policies) import the same numbers instead of drifting apart.
 */

/** Longest accepted secret code (product requirement). */
export const SECRET_CODE_MAX_LENGTH = 15;
/** Default until an administrator configures a code. */
export const DEFAULT_SECRET_CODE = 'opensesame';

/** Milliseconds after sending during which the author may still edit. */
export const MESSAGE_EDIT_WINDOW_MS = 2 * 60 * 1000;

export const MESSAGE_MAX_LENGTH = 4000;
export const MESSAGE_PREVIEW_LENGTH = 80;
export const REPLY_PREVIEW_LENGTH = 80;

export const USER_NAME_MIN_LENGTH = 2;
export const USER_NAME_MAX_LENGTH = 48;
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;

export const IMAGE_MAX_BYTES = 4 * 1024 * 1024;
export const IMAGE_MAX_EDGE_PX = 1600;
export const VOICE_MAX_BYTES = 8 * 1024 * 1024;
export const VOICE_MAX_DURATION_MS = 5 * 60 * 1000;
export const VOICE_MIN_DURATION_MS = 500;

export const ALLOWED_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const;
export const ALLOWED_VOICE_MIME_TYPES = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg'] as const;

/** Page sizes for paginated listings. */
export const DEFAULT_PAGE_SIZE = 25;
export const MAX_PAGE_SIZE = 100;
export const MESSAGE_PAGE_SIZE = 30;

/**
 * Lifetime of the authentication session cookie (a Firebase session cookie).
 * Firebase accepts anything between 5 minutes and 14 days; 7 days matches the
 * "stay signed in on this phone" expectation without being open ended.
 */
export const AUTH_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A Firebase ID token may only be exchanged for a session cookie while the
 * credential is fresh, so a token leaked long after sign-in cannot be upgraded
 * into a week-long session. This is the check Firebase's own session-cookie
 * guide recommends.
 */
export const FRESH_CREDENTIAL_MAX_AGE_MS = 5 * 60 * 1000;

/** Access sessions expire so a backgrounded browser cannot keep chat unlocked. */
export const ACCESS_SESSION_TTL_MS = 30 * 60 * 1000;
/** Signed challenge tokens are short lived by design. */
export const ACCESS_CHALLENGE_TTL_MS = 10 * 60 * 1000;

/** A ringing call is marked missed after this long. */
export const CALL_RING_TIMEOUT_MS = 45 * 1000;

/**
 * Privacy lock: the chat closes and the typing game returns once the page has
 * been *hidden* (Page Visibility API — tab switched, window minimised, screen
 * locked, app backgrounded) for this long. Losing keyboard focus alone does not
 * count; see `hooks/use-inactivity-lock.ts`.
 */
export const CHAT_HIDDEN_LOCK_MS = 60 * 1000;

/**
 * Typing indicator timing. The composer publishes "typing" at most once per
 * `TYPING_HEARTBEAT_MS` while keys are pressed and "stopped" after
 * `TYPING_IDLE_MS` without input; a receiver that hears nothing for
 * `TYPING_TTL_MS` clears the indicator by itself, so a crashed or suspended
 * sender can never leave a permanent "typing…".
 */
export const TYPING_IDLE_MS = 2500;
export const TYPING_HEARTBEAT_MS = 4000;
export const TYPING_TTL_MS = 7000;

/** Receipts are batched for this long so a burst of messages costs one request. */
export const RECEIPT_BATCH_DELAY_MS = 300;
