import { NextResponse } from 'next/server';
import type { ZodError, ZodType } from 'zod';
import { AppError, toAppError } from '@mt/domain';
import { ApiErrorCode, type ApiEnvelope } from '@mt/types';
import { logger } from '../logger';

export function jsonOk<T>(data: T, status = 200, headers?: Record<string, string>): NextResponse {
  const envelope: ApiEnvelope<T> = { ok: true, data };
  return NextResponse.json(envelope, { status, headers });
}

export function jsonError(error: AppError, status?: number): NextResponse {
  const envelope: ApiEnvelope<never> = { ok: false, error: error.toBody() };
  return NextResponse.json(envelope, {
    status: status ?? error.status,
    headers: error.code === ApiErrorCode.RATE_LIMITED ? buildRetryHeaders(error) : undefined,
  });
}

function buildRetryHeaders(error: AppError): Record<string, string> {
  const retryAfter = error.context?.retryAfterSeconds;
  return typeof retryAfter === 'number' ? { 'Retry-After': String(Math.ceil(retryAfter)) } : {};
}

/** Runs a Zod schema and converts failures into a VALIDATION_ERROR envelope. */
export function parseWith<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details: Record<string, string> = {};
    for (const issue of (result.error as ZodError).issues) {
      const path = issue.path.join('.') || '_';
      if (!details[path]) details[path] = issue.message;
    }
    throw AppError.validation(details);
  }
  return result.data;
}

export function isZodError(error: unknown): error is ZodError {
  return typeof error === 'object' && error !== null && 'issues' in error && Array.isArray((error as ZodError).issues);
}

export interface RouteContext {
  requestId: string;
  route: string;
  method: string;
}

/**
 * Wraps a route handler so every endpoint gets the same envelope, error mapping
 * and logging. Handlers only ever throw `AppError` (or a bug, which becomes a
 * generic 500) — no stack traces or messages leak to clients.
 */
export function routeHandler<T>(
  route: string,
  handler: (request: Request, context: { params: Awaited<T> }) => Promise<Response>,
) {
  return async (request: Request, ctx?: { params: T }): Promise<Response> => {
    const requestId = request.headers.get('x-request-id') ?? crypto.randomUUID();
    const startedAt = Date.now();
    try {
      const response = await handler(request, { params: (await ctx?.params) as Awaited<T> });
      logger.debug('api.ok', {
        route,
        method: request.method,
        status: response.status,
        durationMs: Date.now() - startedAt,
        requestId,
      });
      return response;
    } catch (error) {
      const appError = toAppError(error);
      if (appError.code === ApiErrorCode.INTERNAL) {
        logger.error('api.error', { route, method: request.method, requestId, error: String(error) });
      } else {
        logger.warn('api.rejected', {
          route,
          method: request.method,
          code: appError.code,
          requestId,
        });
      }
      return jsonError(appError);
    }
  };
}

export function methodNotAllowed(): NextResponse {
  return jsonError(new AppError(ApiErrorCode.BAD_REQUEST, 'method not allowed'), 405);
}

/** Reads a JSON body, tolerating an empty one. */
export async function readJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    if (request.method === 'GET' || request.method === 'DELETE') return {};
    const text = await request.text();
    if (!text) return {};
    throw new AppError(ApiErrorCode.BAD_REQUEST, 'expected a JSON body');
  }
  try {
    return await request.json();
  } catch {
    throw new AppError(ApiErrorCode.BAD_REQUEST, 'body is not valid JSON');
  }
}

export function readQuery(request: Request): Record<string, string> {
  const url = new URL(request.url);
  const out: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}
