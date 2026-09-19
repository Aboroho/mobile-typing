import { beforeEach, describe, expect, it } from 'vitest';
import type { AuditLogEntry, Dashboard, SecretCodeStatus } from '@mt/types';
import { GET as dashboardRoute } from '@/app/api/v1/admin/dashboard/route';
import { GET as secretCodeRoute, POST as changeSecretCodeRoute } from '@/app/api/v1/admin/secret-code/route';
import { POST as inspectRoute } from '@/app/api/v1/admin/conversations/inspect/route';
import { GET as auditRoute } from '@/app/api/v1/admin/audit-logs/route';
import { POST as createConversationRoute } from '@/app/api/v1/conversations/route';
import { POST as sendMessageRoute } from '@/app/api/v1/messages/route';
import { GET as statusRoute } from '@/app/api/v1/access/status/route';
import { GET as conversationsRoute } from '@/app/api/v1/conversations/route';
import { POST as updateStatusRoute } from '@/app/api/v1/admin/users/[userId]/status/route';
import { POST as loginRoute } from '@/app/api/v1/auth/login/route';
import { call, jar, jsonRequest, queryRequest, registerUser, resetState, unlockJar, type TestUser } from '../helpers/api';

let admin: TestUser;
let alice: TestUser;
let bob: TestUser;
let conversationId: string;

beforeEach(async () => {
  resetState();
  // ADMIN_EMAIL is configured in vitest.setup.ts so this account is the admin.
  admin = await registerUser({ name: 'Root', email: 'admin@example.com' });
  alice = await registerUser({ name: 'Alice', email: 'alice@example.com' });
  bob = await registerUser({ name: 'Bob', email: 'bob@example.com' });
  const created = await call<{ conversation: { conversation: { id: string } } }>(
    createConversationRoute,
    jsonRequest('POST', '/api/v1/conversations', { participantId: bob.id }, alice.jar),
  );
  if (created.status !== 201 || !created.body.data) throw new Error('failed to seed conversation');
  conversationId = created.body.data.conversation.conversation.id;
  await call(
    sendMessageRoute,
    jsonRequest('POST', '/api/v1/messages', { conversationId, type: 'text', text: 'private note', clientMessageId: 'cm-admin-1' }, alice.jar),
  );
});

describe('admin authorisation', () => {
  it('refuses a signed-in non-administrator', async () => {
    const denied = await call(dashboardRoute, queryRequest('GET', '/api/v1/admin/dashboard', undefined, alice.jar));
    expect(denied.status).toBe(403);
    expect(denied.body.error?.code).toBe('FORBIDDEN');
  });

  it('refuses an anonymous caller before the admin check even runs', async () => {
    const denied = await call(dashboardRoute, queryRequest('GET', '/api/v1/admin/dashboard'));
    expect(denied.status).toBe(403);
    expect(denied.body.error?.code).toBe('ACCESS_REQUIRED');
    expect(JSON.stringify(denied.body)).not.toContain('admin@example.com');
  });

  it('serves the dashboard to the configured administrator', async () => {
    const result = await call<{ dashboard: Dashboard }>(dashboardRoute, queryRequest('GET', '/api/v1/admin/dashboard', undefined, admin.jar));
    expect(result.status).toBe(200);
    const stats = result.body.data?.dashboard.stats;
    expect(stats?.totalUsers).toBe(3);
    expect(stats?.conversations).toBe(1);
    expect(stats?.messages).toBeGreaterThanOrEqual(1);
  });
});

describe('conversation inspection', () => {
  it('returns messages including deleted ones, and writes an audit entry', async () => {
    const inspect = await call<{ conversationId: string; messageCount: number }>(
      inspectRoute,
      jsonRequest('POST', '/api/v1/admin/conversations/inspect', { participantA: alice.id, participantB: bob.id }, admin.jar),
    );
    expect(inspect.status).toBe(200);
    expect(inspect.body.data?.messageCount).toBeGreaterThanOrEqual(1);

    const audit = await call<{ items: AuditLogEntry[] }>(auditRoute, queryRequest('GET', '/api/v1/admin/audit-logs', { limit: 20 }, admin.jar));
    const actions = (audit.body.data?.items ?? []).map((entry) => entry.action);
    expect(actions).toContain('admin.conversation.inspected');
  });
});

describe('secret code management', () => {
  it('never returns the code itself', async () => {
    const result = await call<{ status: SecretCodeStatus }>(secretCodeRoute, queryRequest('GET', '/api/v1/admin/secret-code', undefined, admin.jar));
    expect(result.status).toBe(200);
    expect(result.body.data?.status.configured).toBe(true);
    expect(JSON.stringify(result.body)).not.toContain('opensesame');
  });

  it('rotating the code signs every existing access session out', async () => {
    const before = await call<{ unlocked: boolean }>(statusRoute, queryRequest('GET', '/api/v1/access/status', undefined, alice.jar));
    expect(before.body.data?.unlocked).toBe(true);

    const rotated = await call(
      changeSecretCodeRoute,
      jsonRequest('POST', '/api/v1/admin/secret-code', { code: 'newsecret1', confirmCode: 'newsecret1', strategy: 'rotate' }, admin.jar),
    );
    expect(rotated.status).toBe(200);

    const after = await call<{ unlocked: boolean }>(statusRoute, queryRequest('GET', '/api/v1/access/status', undefined, alice.jar));
    expect(after.body.data?.unlocked).toBe(false);
    const denied = await call(conversationsRoute, queryRequest('GET', '/api/v1/conversations', undefined, alice.jar));
    expect(denied.status).toBe(403);

    const fresh = await unlockJar(jar());
    const restored = await call<{ unlocked: boolean }>(statusRoute, queryRequest('GET', '/api/v1/access/status', undefined, fresh));
    expect(restored.body.data?.unlocked).toBe(true);
  });

  it('rejects a mismatched confirmation and an over-long code', async () => {
    const mismatch = await call(
      changeSecretCodeRoute,
      jsonRequest('POST', '/api/v1/admin/secret-code', { code: 'newsecret1', confirmCode: 'different1', strategy: 'rotate' }, admin.jar),
    );
    expect(mismatch.status).toBe(422);

    const tooLong = await call(
      changeSecretCodeRoute,
      jsonRequest('POST', '/api/v1/admin/secret-code', { code: 'a'.repeat(16), confirmCode: 'a'.repeat(16), strategy: 'rotate' }, admin.jar),
    );
    expect(tooLong.status).toBe(422);
  });
});

describe('user management', () => {
  it('disables an account so its session dies and it cannot sign in again', async () => {
    const before = await call(conversationsRoute, queryRequest('GET', '/api/v1/conversations', undefined, bob.jar));
    expect(before.status).toBe(200);

    const disabled = await call(
      updateStatusRoute,
      jsonRequest('POST', `/api/v1/admin/users/${bob.id}/status`, { status: 'disabled', reason: 'abuse' }, admin.jar),
      { userId: bob.id },
    );
    expect(disabled.status).toBe(200);

    const after = await call(conversationsRoute, queryRequest('GET', '/api/v1/conversations', undefined, bob.jar));
    expect(after.status).toBe(401);

    // A fresh login with the right password is refused because the account is disabled.
    const fresh = jar();
    const login = await call(loginRoute, jsonRequest('POST', '/api/v1/auth/login', { email: 'bob@example.com', password: 'CorrectHorse1!' }, fresh));
    expect(login.status).toBe(401);
  });

  it('refuses to lock the administrator out of their own account', async () => {
    const selfDisable = await call(
      updateStatusRoute,
      jsonRequest('POST', `/api/v1/admin/users/${admin.id}/status`, { status: 'disabled' }, admin.jar),
      { userId: admin.id },
    );
    expect(selfDisable.status).toBeGreaterThanOrEqual(400);
  });
});
