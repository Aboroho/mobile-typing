/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authClientMessage, getAuthClient, resetAuthClient } from '@/lib/client/auth-client';

describe('auth client', () => {
  beforeEach(() => {
    resetAuthClient();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetAuthClient();
  });

  it('returns a client without throwing', async () => {
    const client = await getAuthClient();
    expect(typeof client.signIn).toBe('function');
    expect(typeof client.signUp).toBe('function');
    expect(typeof client.signOut).toBe('function');
  });

  it('maps AuthClientError to message', () => {
    const err = { name: 'AuthClientError', status: 401, message: 'invalid credentials' };
    expect(authClientMessage(err)).toBe('invalid credentials');
  });
});
