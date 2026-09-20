import type {
  AccessChallenge,
  AccessLockResult,
  AuditLogEntry,
  Call,
  Cursor,
  Dashboard,
  Media,
  SecretCodeStatus,
  TypingSession,
  UserProfile,
  UserSearchResult,
} from '@mt/types';
import type {
  ChangeSecretCodeInput,
  CreateCallInput,
  CreateMediaIntentInput,
  DeleteMessageInput,
  EditMessageInput,
  EndCallInput,
  LoginInput,
  MarkConversationReadInput,
  MarkDeliveredInput,
  RegisterInput,
  SendMediaMessageInput,
  SendMessageInput,
  SignalCallInput,
  SubmitTypingSessionInput,
  UnlockAccessInput,
  UpdateProfileInput,
} from '@mt/validation';
import { ApiClientError } from './errors';
import type {
  AccessStatusResponse,
  AdminAuditResponse,
  AdminConversationResponse,
  AdminMediaListResponse,
  AdminMessageListResponse,
  AdminUserListResponse,
  AuthResult,
  CallCreateResponse,
  CallHistoryResponse,
  ConversationDetailResponse,
  ConversationListResponse,
  HealthResponse,
  IceServerResponse,
  MediaViewResult,
  MessageListResponse,
  PresenceResponse,
  ReauthenticateResult,
  SendMessageResponse,
  SessionUser,
  TypingSessionResponse,
  UnlockResult,
  UploadIntentResponse,
  UploadResult,
} from './dto';

/**
 * Query parameter shapes.
 *
 * These are plain interfaces rather than Zod inferred types: the server coerces
 * query strings (`?limit=30` -> number), whose *input* type is `unknown`, which
 * is useless to a typed client. The server still validates everything.
 */
export interface ListConversationsParams {
  limit?: number;
  cursor?: string | null;
}

export interface ListMessagesParams {
  limit?: number;
  before?: string;
  after?: string;
  q?: string;
}

export interface ListCallsParams {
  conversationId?: string;
  limit?: number;
  cursor?: string | null;
}

export interface AdminQueryParams {
  [key: string]: string | number | boolean | null | undefined;
  q?: string;
  status?: string;
  kind?: string;
  action?: string;
  actorUid?: string;
  includeDeleted?: boolean;
  viewOnceOnly?: boolean;
  limit?: number;
  cursor?: string | null;
}

export interface ApiClientInit {
  /** Defaults to same origin, which keeps the client proxy friendly. */
  baseUrl?: string;
  /** Session-token provider for `Authorization: Bearer` requests. Omit when using cookie sessions. */
  getToken?: () => Promise<string | null> | string | null;
  fetchImpl?: typeof fetch;
  /** Called for every response; useful for global "session expired" handling. */
  onResponse?: (response: { ok: boolean; status: number; code?: string }) => void;
}

/**
 * Correlation id sent with every request as `x-request-id`.
 *
 * The server echoes it in the response header and includes it in every log
 * line, so one browser action can be followed through the API logs. Generated
 * per call, never derived from user data.
 */
function newRequestId(): string {
  const cryptoRef = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoRef && typeof cryptoRef.randomUUID === 'function') return cryptoRef.randomUUID();
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, unknown>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

/** Serialises a query object, dropping undefined/null values. */
function buildQuery(query?: RequestOptions['query']): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    // Only primitives are meaningful in a query string.
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') continue;
    params.set(key, String(value));
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
}

/**
 * Typed HTTP client for `/api/v1`. The web app and a future React Native app use
 * this exact client, so route shapes are defined once.
 */
export function createApiClient(init: ApiClientInit = {}) {
  const baseUrl = init.baseUrl ?? '';
  const doFetch: typeof fetch = init.fetchImpl ?? ((...args) => fetch(...args));

  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'x-request-id': newRequestId(),
      ...(options.headers ?? {}),
    };
    if (options.body !== undefined && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    if (init.getToken) {
      const token = await init.getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    const response = await doFetch(`${baseUrl}${path}${buildQuery(options.query)}`, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'include',
      body:
        options.body === undefined
          ? undefined
          : options.body instanceof FormData
            ? options.body
            : JSON.stringify(options.body),
      signal: options.signal,
    });

    const contentType = response.headers.get('content-type') ?? '';
    let payload: unknown = null;
    if (contentType.includes('application/json')) {
      payload = await response.json();
    }

    const envelope = payload as { ok: boolean; data?: T; error?: Record<string, unknown> } | null;
    init.onResponse?.({
      ok: response.ok,
      status: response.status,
      code: envelope?.error?.['code'] as string | undefined,
    });

    if (!response.ok || !envelope?.ok) {
      const error = envelope?.error ?? {};
      throw new ApiClientError({
        code: (error['code'] as never) ?? 'INTERNAL',
        message: (error['message'] as string) ?? `request failed with ${response.status}`,
        status: response.status,
        details: error['details'] as Record<string, string> | undefined,
        context: error['context'] as Record<string, string | number | boolean> | undefined,
      });
    }
    return envelope.data as T;
  }

  function uploadBytes(
    path: string,
    blob: Blob,
    options: { onProgress?: (ratio: number) => void; signal?: AbortSignal } = {},
  ): Promise<UploadResult> {
    const form = new FormData();
    form.append('file', blob, blob instanceof File ? blob.name : 'upload.bin');

    // XHR is used when available because it reports upload progress; fetch does not.
    if (typeof XMLHttpRequest !== 'undefined') {
      return new Promise<UploadResult>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${baseUrl}${path}`);
        xhr.withCredentials = true;
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) options.onProgress?.(event.loaded / event.total);
        };
        xhr.onload = () => {
          let payload: { ok: boolean; data?: UploadResult; error?: { code: string; message: string } };
          try {
            payload = JSON.parse(xhr.responseText) as typeof payload;
          } catch {
            reject(new ApiClientError({ code: 'INTERNAL', message: 'invalid upload response', status: xhr.status }));
            return;
          }
          if (xhr.status >= 200 && xhr.status < 300 && payload.ok && payload.data) {
            resolve(payload.data);
            return;
          }
          reject(
            new ApiClientError({
              code: (payload.error?.code as never) ?? 'INTERNAL',
              message: payload.error?.message ?? 'upload failed',
              status: xhr.status,
            }),
          );
        };
        xhr.onerror = () =>
          reject(new ApiClientError({ code: 'INTERNAL', message: 'network error during upload', status: 0 }));
        options.signal?.addEventListener('abort', () => xhr.abort());
        xhr.send(form);
      });
    }

    return request<UploadResult>(path, { method: 'POST', body: form, signal: options.signal });
  }

  return {
    health: () => request<HealthResponse>('/api/v1/health'),

    access: {
      status: () => request<AccessStatusResponse>('/api/v1/access/status'),
      challenge: () => request<{ challenge: AccessChallenge }>('/api/v1/access/challenge', { method: 'POST' }),
      unlock: (input: UnlockAccessInput) =>
        request<UnlockResult>('/api/v1/access/unlock', { method: 'POST', body: input }),
      lock: () => request<AccessLockResult>('/api/v1/access/lock', { method: 'POST' }),
    },

    auth: {
      me: () => request<{ user: SessionUser | null }>('/api/v1/auth/me'),
      /**
       * Creates the account (`{ name, email, password }`, verified server-side
       * against an Argon2 hash) and establishes the `mt_session` cookie
       * session. Re-registering an existing email re-issues a session instead
       * of failing, so accounts cannot be enumerated.
       */
      register: (input: RegisterInput) =>
        request<AuthResult>('/api/v1/auth/register', { method: 'POST', body: input }),
      login: (input: LoginInput) =>
        request<AuthResult>('/api/v1/auth/login', { method: 'POST', body: input }),
      logout: () => request<{ loggedOut: boolean }>('/api/v1/auth/logout', { method: 'POST' }),
      reauthenticate: (input: { password: string }) =>
        request<ReauthenticateResult>('/api/v1/auth/reauthenticate', { method: 'POST', body: input }),
      updateProfile: (input: UpdateProfileInput) =>
        request<{ user: SessionUser }>('/api/v1/auth/profile', { method: 'PATCH', body: input }),
    },

    users: {
      search: (q: string, limit = 20) =>
        request<{ items: UserSearchResult[] }>('/api/v1/users/search', { query: { q, limit } }),
      presence: (userId: string, state: 'online' | 'offline') =>
        request<PresenceResponse>('/api/v1/users/presence', { method: 'POST', body: { userId, state } }),
    },

    conversations: {
      list: (params: ListConversationsParams = {}) =>
        request<ConversationListResponse>('/api/v1/conversations', {
          query: { limit: params.limit, cursor: params.cursor ?? undefined },
        }),
      create: (participantId: string) =>
        request<{ conversation: ConversationDetailResponse['conversation'] }>('/api/v1/conversations', {
          method: 'POST',
          body: { participantId },
        }),
      get: (conversationId: string) =>
        request<ConversationDetailResponse>(`/api/v1/conversations/${conversationId}`),
      markRead: (conversationId: string, input: MarkConversationReadInput) =>
        request<{ ok: true }>(`/api/v1/conversations/${conversationId}/read`, {
          method: 'POST',
          body: input,
        }),
      hide: (conversationId: string, hidden: boolean) =>
        request<{ hidden: boolean }>(`/api/v1/conversations/${conversationId}/visibility`, {
          method: 'POST',
          body: { hidden },
        }),
      block: (conversationId: string, blockedUserId: string, blocked: boolean) =>
        request<{ blocked: boolean }>(`/api/v1/conversations/${conversationId}/block`, {
          method: 'POST',
          body: { blockedUserId, blocked },
        }),
      typing: (conversationId: string, isTyping: boolean) =>
        request<{ ok: true }>(`/api/v1/conversations/${conversationId}/typing`, {
          method: 'POST',
          body: { isTyping },
        }),
    },

    messages: {
      list: (conversationId: string, params: ListMessagesParams = {}) =>
        request<MessageListResponse>(`/api/v1/conversations/${conversationId}/messages`, {
          query: {
            limit: params.limit,
            before: params.before,
            after: params.after,
            q: params.q,
          },
        }),
      send: (input: SendMessageInput) =>
        request<SendMessageResponse>('/api/v1/messages', { method: 'POST', body: input }),
      edit: (messageId: string, input: EditMessageInput) =>
        request<SendMessageResponse>(`/api/v1/messages/${messageId}`, { method: 'PATCH', body: input }),
      remove: (messageId: string, input: DeleteMessageInput = { scope: 'everyone' }) =>
        request<{ deleted: true }>(`/api/v1/messages/${messageId}`, { method: 'DELETE', body: input }),
      markDelivered: (conversationId: string, input: MarkDeliveredInput) =>
        request<{ updated: number }>(`/api/v1/conversations/${conversationId}/messages/delivery`, {
          method: 'POST',
          body: input,
        }),
    },

    media: {
      createIntent: (input: CreateMediaIntentInput) =>
        request<UploadIntentResponse>('/api/v1/media/upload-intent', { method: 'POST', body: input }),
      upload: (mediaId: string, blob: Blob, onProgress?: (ratio: number) => void, signal?: AbortSignal) =>
        uploadBytes(`/api/v1/media/${mediaId}/upload`, blob, { onProgress, signal }),
      send: (input: SendMediaMessageInput) =>
        request<SendMessageResponse>('/api/v1/media/messages', { method: 'POST', body: input }),
      openViewOnce: (mediaId: string) =>
        request<MediaViewResult>(`/api/v1/media/${mediaId}/view`, { method: 'POST' }),
      markViewed: (mediaId: string) =>
        request<{ viewed: boolean }>(`/api/v1/media/${mediaId}/viewed`, { method: 'POST' }),
      remove: (mediaId: string, reason?: string) =>
        request<{ deleted: true }>(`/api/v1/media/${mediaId}`, { method: 'DELETE', body: { reason } }),
      detail: (mediaId: string) => request<{ media: Media }>(`/api/v1/media/${mediaId}`),
    },

    calls: {
      iceServers: () => request<IceServerResponse>('/api/v1/calls/ice-servers'),
      create: (input: CreateCallInput) =>
        request<CallCreateResponse>('/api/v1/calls', { method: 'POST', body: input }),
      signal: (callId: string, input: SignalCallInput) =>
        request<{ accepted: boolean }>(`/api/v1/calls/${callId}/signal`, { method: 'POST', body: input }),
      accept: (callId: string) =>
        request<{ call: Call }>(`/api/v1/calls/${callId}/accept`, { method: 'POST', body: {} }),
      reject: (callId: string, reason?: string) =>
        request<{ call: Call }>(`/api/v1/calls/${callId}/reject`, { method: 'POST', body: { reason } }),
      end: (callId: string, input: EndCallInput = { reason: 'hangup' }) =>
        request<{ call: Call }>(`/api/v1/calls/${callId}/end`, { method: 'POST', body: input }),
      history: (params: ListCallsParams = {}) =>
        request<CallHistoryResponse>('/api/v1/calls', {
          query: { conversationId: params.conversationId, limit: params.limit, cursor: params.cursor ?? undefined },
        }),
      events: (scope: 'me' | string) => `/api/v1/calls/events?scope=${encodeURIComponent(scope)}`,
    },

    typing: {
      submit: (input: SubmitTypingSessionInput) =>
        request<TypingSessionResponse>('/api/v1/typing/sessions', { method: 'POST', body: input }),
    },

    admin: {
      dashboard: () => request<{ dashboard: Dashboard }>('/api/v1/admin/dashboard'),
      secretCode: () => request<{ status: SecretCodeStatus }>('/api/v1/admin/secret-code'),
      changeSecretCode: (input: ChangeSecretCodeInput) =>
        request<{ status: SecretCodeStatus }>('/api/v1/admin/secret-code', { method: 'POST', body: input }),
      users: (params: AdminQueryParams = {}) =>
        request<AdminUserListResponse>('/api/v1/admin/users', { query: params }),
      user: (userId: string) =>
        request<{ user: UserProfile; conversationCount: number; messageCount: number }>(
          `/api/v1/admin/users/${userId}`,
        ),
      updateUserStatus: (userId: string, status: 'active' | 'disabled', reason?: string) =>
        request<{ user: UserProfile }>(`/api/v1/admin/users/${userId}/status`, {
          method: 'POST',
          body: { status, reason },
        }),
      inspectConversation: (participantA: string, participantB: string) =>
        request<AdminConversationResponse>('/api/v1/admin/conversations/inspect', {
          method: 'POST',
          body: { participantA, participantB },
        }),
      messages: (conversationId: string, params: AdminQueryParams = {}) =>
        request<AdminMessageListResponse>(`/api/v1/admin/conversations/${conversationId}/messages`, {
          query: params,
        }),
      media: (params: AdminQueryParams = {}) =>
        request<AdminMediaListResponse>('/api/v1/admin/media', { query: params }),
      mediaContent: (mediaId: string) => `/api/v1/admin/media/${mediaId}/content`,
      calls: (params: AdminQueryParams = {}) =>
        request<CallHistoryResponse>('/api/v1/admin/calls', { query: params }),
      audit: (params: AdminQueryParams = {}) =>
        request<AdminAuditResponse>('/api/v1/admin/audit-logs', { query: params }),
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** Convenience cursor helpers shared by list views. */
export function hasMore<T>(cursor: Cursor<T>): boolean {
  return cursor.hasMore;
}

export type { AuditLogEntry, TypingSession, SecretCodeStatus, Dashboard };
