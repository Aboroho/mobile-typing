/**
 * Stable machine readable error codes. Clients branch on `code`, never on the
 * human readable `message`, so messages can be re-worded without breaking
 * clients (e.g. to avoid leaking whether an account exists).
 */
export const ApiErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE',
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
  RATE_LIMITED: 'RATE_LIMITED',
  LOCKED: 'LOCKED',
  ACCESS_REQUIRED: 'ACCESS_REQUIRED',
  ACCOUNT_DISABLED: 'ACCOUNT_DISABLED',
  PRECONDITION_FAILED: 'PRECONDITION_FAILED',
  INTERNAL: 'INTERNAL',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
} as const;

export type ApiErrorCodeValue = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

export interface ApiErrorBody {
  code: ApiErrorCodeValue;
  message: string;
  /** Field level details for VALIDATION_ERROR responses. */
  details?: Record<string, string>;
  /** Safe, non sensitive context (never tokens, passwords or message bodies). */
  context?: Record<string, string | number | boolean>;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiFailure {
  ok: false;
  error: ApiErrorBody;
}

export type ApiEnvelope<T> = ApiSuccess<T> | ApiFailure;

export type ApiData<T extends ApiEnvelope<unknown>> = T extends ApiSuccess<infer D> ? D : never;
