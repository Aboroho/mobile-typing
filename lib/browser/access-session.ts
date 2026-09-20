import { parsePublicEnv } from '@mt/config';

/**
 * "Is this browser's access session still valid?" probe for the streaming
 * transports.
 *
 * A rejected `EventSource` is indistinguishable from a flaky network: the
 * `error` event carries no status, so a stream that answers 403
 * `ACCESS_REQUIRED` — the access session expired after 30 minutes, or another
 * tab hid the chat — is retried forever and fills the server log with 403s.
 * Before giving up on a stream, the transports ask this probe; when the access
 * session really is gone the app returns to the typing game instead of
 * hammering a route it may not read.
 *
 * The answer is cached for a moment because several streams can fail at once,
 * and it fails *open*: a network error means "keep retrying", never "you are
 * locked out".
 */
const PROBE_TTL_MS = 5_000;
const PROBE_TIMEOUT_MS = 4_000;

let cached: { at: number; locked: boolean } | null = null;
let inFlight: Promise<boolean> | null = null;

/** Test helper. */
export function resetAccessSessionProbe(): void {
  cached = null;
  inFlight = null;
}

/** True when the server reports that this browser has no access session. */
export async function accessSessionGone(): Promise<boolean> {
  // With the typing game disabled there is no access session to hold.
  if (!parsePublicEnv().NEXT_PUBLIC_ENABLE_TYPING_GAME) return false;

  const now = Date.now();
  if (cached && now - cached.at < PROBE_TTL_MS) return cached.locked;
  if (inFlight) return inFlight;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  inFlight = (async () => {
    try {
      const response = await fetch('/api/v1/access/status', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { data?: { unlocked?: boolean } };
      const locked = body.data?.unlocked === false;
      cached = { at: Date.now(), locked };
      return locked;
    } catch {
      // Offline, aborted or an unexpected payload: keep the transport alive.
      return false;
    } finally {
      clearTimeout(timeout);
      inFlight = null;
    }
  })();

  return inFlight;
}
