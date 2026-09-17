import { beforeEach, describe, expect, it } from 'vitest';
import { resetStore } from '@/lib/data/memory';
import { ACCESS_COOKIE } from '@/lib/auth/types';
import { POST as challengeRoute } from '@/app/api/v1/access/challenge/route';
import { POST as unlockRoute } from '@/app/api/v1/access/unlock/route';
import { POST as lockRoute } from '@/app/api/v1/access/lock/route';
import { GET as statusRoute } from '@/app/api/v1/access/status/route';
import { GET as healthRoute } from '@/app/api/v1/health/route';
import { absorb, call, jar, jsonRequest, queryRequest, sha256, unlockJar } from '../helpers/api';

beforeEach(() => resetStore());

async function newChallenge(target = jar()) {
  const response = await challengeRoute(jsonRequest('POST', '/api/v1/access/challenge', {}, target));
  absorb(response, target);
  const body = (await response.json()) as { data: { challenge: { challengeToken: string; code: string } } };
  return body.data.challenge;
}

describe('the access gate', () => {
  it('hands the browser a challenge and the code it must match locally', async () => {
    const challenge = await newChallenge();
    expect(challenge.code).toBe('opensesame');
    expect(challenge.challengeToken.length).toBeGreaterThan(20);
  });

  it('refuses a wrong digest with a generic error and no cookie', async () => {
    const target = jar();
    const challenge = await newChallenge(target);
    const wrong = await call(
      unlockRoute,
      jsonRequest(
        'POST',
        '/api/v1/access/unlock',
        { challengeToken: challenge.challengeToken, digest: sha256('not-the-code') },
        target,
      ),
    );
    expect(wrong.status).toBe(412);
    expect(wrong.body.error?.message).toBe('that was not the right sequence');
    expect(target.cookies[ACCESS_COOKIE]).toBeUndefined();
  });

  it('issues an access session cookie for the right digest', async () => {
    const target = await unlockJar();
    expect(target.cookies[ACCESS_COOKIE]).toBeDefined();
  });

  it('reports locked, then unlocked, for the same jar', async () => {
    const target = jar();
    const before = await call<{ unlocked: boolean }>(statusRoute, queryRequest('GET', '/api/v1/access/status', undefined, target));
    expect(before.body.data?.unlocked).toBe(false);

    await unlockJar(target);
    const after = await call<{ unlocked: boolean }>(statusRoute, queryRequest('GET', '/api/v1/access/status', undefined, target));
    expect(after.body.data?.unlocked).toBe(true);
  });

  it('cannot replay a challenge token twice', async () => {
    const target = jar();
    const challenge = await newChallenge(target);
    const first = await unlockRoute(
      jsonRequest('POST', '/api/v1/access/unlock', { challengeToken: challenge.challengeToken, digest: sha256(challenge.code) }, target),
    );
    expect(first.status).toBe(200);
    const second = await call(
      unlockRoute,
      jsonRequest('POST', '/api/v1/access/unlock', { challengeToken: challenge.challengeToken, digest: sha256(challenge.code) }, target),
    );
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  it('locks again on demand and clears the cookie', async () => {
    const target = await unlockJar();
    const locked = await lockRoute(jsonRequest('POST', '/api/v1/access/lock', {}, target));
    expect(locked.status).toBe(200);
    absorb(locked, target);
    const status = await call<{ unlocked: boolean }>(statusRoute, queryRequest('GET', '/api/v1/access/status', undefined, target));
    expect(status.body.data?.unlocked).toBe(false);
  });

  it('never leaks the secret code through the health endpoint', async () => {
    const { body } = await call(healthRoute, queryRequest('GET', '/api/v1/health'));
    expect(JSON.stringify(body)).not.toContain('opensesame');
  });
});
