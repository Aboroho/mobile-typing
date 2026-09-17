import { AppError } from '@mt/domain';
import { verifyAccessSession } from '../access/access-service';
import { getData } from '../data';
import { env } from '../env';
import { logger } from '../logger';
import { readCookie } from './cookies';
import { isAdminUser, resolveAuth } from './session';
import { ACCESS_COOKIE, type ResolvedAuth } from './types';

/** Requires a valid, active account. Throws UNAUTHENTICATED otherwise. */
export async function requireUser(request: Request): Promise<ResolvedAuth> {
  const auth = await resolveAuth(request);
  if (!auth) throw AppError.unauthenticated();
  return auth;
}

/**
 * Requires the configured administrator. Every admin route funnels through here,
 * so authorisation cannot be forgotten on a new endpoint.
 */
export async function requireAdmin(request: Request): Promise<ResolvedAuth> {
  const auth = await requireUser(request);
  if (!isAdminUser(auth.user)) {
    logger.warn('admin.access_denied', { uid: auth.user.id });
    throw AppError.forbidden('administrator access required');
  }
  return auth;
}

/**
 * Requires an unexpired access session (the secret-code unlock) whose epoch
 * matches the currently configured secret code. Rotating the code invalidates
 * every previously issued session, which is the documented strategy for
 * invalidating old access challenges.
 *
 * When `NEXT_PUBLIC_ENABLE_TYPING_GAME=false` the typing-game disguise and its
 * secret-code gate are not shown on the client, so there is no way for a
 * browser to ever obtain an access-session cookie — this check is skipped
 * entirely to match.
 */
export async function requireAccess(request: Request): Promise<{ epoch: number; userId: string | null }> {
  if (!env().NEXT_PUBLIC_ENABLE_TYPING_GAME) return { epoch: 0, userId: null };
  const cookie = readCookie(request, ACCESS_COOKIE);
  const session = await verifyAccessSession(cookie);
  if (!session) throw AppError.accessRequired();
  const data = await getData();
  const config = await data.config.getAccessConfig();
  if (session.epoch !== config.epoch) throw AppError.accessRequired('access session was invalidated');
  return { epoch: session.epoch, userId: session.userId };
}

/**
 * Administrator + access session.
 *
 * Administrators are not exempt from the typing-game access flow: the admin API
 * requires a valid access session as well as the configured admin identity.
 */
export async function requireAdminAccess(request: Request): Promise<ResolvedAuth> {
  await requireAccess(request);
  return requireAdmin(request);
}

/** Authentication + access session, the standard gate for user facing routes. */
export async function requireAuthenticatedAccess(request: Request): Promise<
  ResolvedAuth & { access: { epoch: number } }
> {
  const auth = await requireUser(request);
  const access = await requireAccess(request);
  return { ...auth, access: { epoch: access.epoch } };
}
