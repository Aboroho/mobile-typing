import { AppError } from '@mt/domain';
import { env } from '../env';
import { getData } from '../data';

/** Best effort client identification: proxy headers first, then the socket. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? 'unknown';
  const realIp = request.headers.get('x-real-ip');
  if (realIp) return realIp;
  return 'unknown';
}

export interface RateLimitOptions {
  limit?: number;
  windowMs?: number;
  /** Extra discriminator, e.g. the target email or conversation id. */
  subject?: string;
}

/**
 * Fixed window rate limit keyed by IP + route (+ optional subject). It exists to
 * blunt credential stuffing and secret-code brute forcing; it is not a quota
 * system and is deliberately permissive for ordinary chat traffic.
 */
export async function enforceRateLimit(
  request: Request,
  key: string,
  options: RateLimitOptions = {},
): Promise<void> {
  const configured = env();
  const limit = options.limit ?? configured.RATE_LIMIT_MAX;
  const windowMs = options.windowMs ?? configured.RATE_LIMIT_WINDOW_MS;
  const ip = clientIp(request);
  const composite = [key, ip, options.subject ?? ''].filter(Boolean).join('|');
  const data = await getData();
  const result = await data.rateLimits.consume(composite, { limit, windowMs });
  if (!result.allowed) {
    throw AppError.rateLimited(result.retryAfterSeconds);
  }
}
