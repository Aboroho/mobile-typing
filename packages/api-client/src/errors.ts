import type { ApiErrorCodeValue } from '@mt/types';

/** Thrown by the API client for any non 2xx response. */
export class ApiClientError extends Error {
  readonly code: ApiErrorCodeValue;
  readonly status: number;
  readonly details?: Record<string, string>;
  readonly context?: Record<string, string | number | boolean>;

  constructor(init: {
    code: ApiErrorCodeValue;
    message: string;
    status: number;
    details?: Record<string, string>;
    context?: Record<string, string | number | boolean>;
  }) {
    super(init.message);
    this.name = 'ApiClientError';
    this.code = init.code;
    this.status = init.status;
    this.details = init.details;
    this.context = init.context;
  }

  get isAccessRequired(): boolean {
    return this.code === 'ACCESS_REQUIRED';
  }

  get isUnauthenticated(): boolean {
    return this.code === 'UNAUTHENTICATED';
  }
}
