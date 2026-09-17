import { ApiErrorCode, type ApiErrorCodeValue, type ApiErrorBody } from '@mt/types';

const STATUS: Record<ApiErrorCodeValue, number> = {
  BAD_REQUEST: 400,
  VALIDATION_ERROR: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  LOCKED: 423,
  ACCESS_REQUIRED: 403,
  ACCOUNT_DISABLED: 403,
  PRECONDITION_FAILED: 412,
  INTERNAL: 500,
  NOT_IMPLEMENTED: 501,
};

export class AppError extends Error {
  readonly code: ApiErrorCodeValue;
  readonly details?: Record<string, string>;
  readonly context?: Record<string, string | number | boolean>;

  constructor(
    code: ApiErrorCodeValue,
    message: string,
    options?: {
      details?: Record<string, string>;
      context?: Record<string, string | number | boolean>;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = 'AppError';
    this.code = code;
    this.details = options?.details;
    this.context = options?.context;
  }

  get status(): number {
    return httpStatusFor(this.code);
  }

  toBody(): ApiErrorBody {
    return {
      code: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {}),
      ...(this.context ? { context: this.context } : {}),
    };
  }

  static validation(details: Record<string, string>, message = 'validation failed'): AppError {
    return new AppError(ApiErrorCode.VALIDATION_ERROR, message, { details });
  }

  static unauthenticated(message = 'authentication required'): AppError {
    return new AppError(ApiErrorCode.UNAUTHENTICATED, message);
  }

  static accessRequired(message = 'access session required'): AppError {
    return new AppError(ApiErrorCode.ACCESS_REQUIRED, message);
  }

  static forbidden(message = 'you do not have access to this resource'): AppError {
    return new AppError(ApiErrorCode.FORBIDDEN, message);
  }

  static notFound(message = 'resource not found'): AppError {
    return new AppError(ApiErrorCode.NOT_FOUND, message);
  }

  static conflict(message: string, context?: Record<string, string | number | boolean>): AppError {
    return new AppError(ApiErrorCode.CONFLICT, message, { context });
  }

  static precondition(message: string): AppError {
    return new AppError(ApiErrorCode.PRECONDITION_FAILED, message);
  }

  static rateLimited(retryAfterSeconds: number): AppError {
    return new AppError(ApiErrorCode.RATE_LIMITED, 'too many requests, slow down', {
      context: { retryAfterSeconds },
    });
  }

  static internal(cause?: unknown): AppError {
    return new AppError(ApiErrorCode.INTERNAL, 'something went wrong', { cause });
  }
}

export function httpStatusFor(code: ApiErrorCodeValue): number {
  return STATUS[code];
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Converts any thrown value into an `AppError`. Unexpected errors become a
 * generic 500 so implementation details never reach the client.
 */
export function toAppError(error: unknown): AppError {
  if (isAppError(error)) return error;
  if (error instanceof Error && error.name === 'ZodError') {
    return AppError.validation({}, 'validation failed');
  }
  return AppError.internal(error);
}
