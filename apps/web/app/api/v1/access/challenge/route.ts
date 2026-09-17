import { routeHandler, jsonOk, readJson, parseWith } from '@/lib/api/http';
import { startAccessSessionSchema } from '@mt/validation';
import { createChallenge } from '@/lib/access/access-service';
import { resolveAuth } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

/**
 * Starts a typing-game session and hands the browser the current secret code so
 * it can be matched locally. Rate limited; the code is never rendered or logged.
 */
export const POST = routeHandler('/api/v1/access/challenge', async (request) => {
  const input = parseWith(startAccessSessionSchema, await readJson(request));
  // Binding the challenge to a signed-in user is optional but makes the
  // resulting access session immediately usable after reauthentication.
  const auth = await resolveAuth(request).catch(() => null);
  const challenge = await createChallenge({ request, userId: auth?.user.id });
  void input;
  return jsonOk({ challenge });
});
