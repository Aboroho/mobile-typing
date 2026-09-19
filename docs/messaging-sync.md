# Messaging synchronisation, receipts, typing and chat hiding

This document is the reference for how a message moves between two browsers,
what each delivery state means, how typing indicators work, and how the chat is
hidden. It also records the root cause of the duplicate-message bug and the
model that replaced it.

Code map:

| Concern | Where |
| --- | --- |
| Pure reconciliation rules (no I/O) | `lib/domain/message-sync.ts` |
| Client source of truth | `stores/chat-store.ts` |
| Receipts (server) | `lib/services/receipt-service.ts` |
| Typing relay (server) | `lib/services/conversation-service.ts` → `setTyping` |
| Typing throttle / expiry (client) | `lib/browser/typing-indicator.ts` |
| "Seen" detection (client) | `hooks/use-seen-observer.ts` |
| Hide coordinator | `lib/client/privacy-lock.ts` |
| Inactivity rule | `hooks/use-inactivity-lock.ts`, `lib/browser/hidden-timer.ts` |
| Double-tap gesture | `lib/browser/double-tap.ts`, `hooks/use-double-tap.ts` |

---

## 1. The duplicate-message bug — root cause

**Symptom.** After sending, the message appeared twice in the sender's list; one
copy vanished a moment later.

**Cause.** Two independent sources delivered the same message under two
different identities, and the list keyed on the wrong one.

1. `sendText` inserted an optimistic row whose `id` was the client-generated
   `clientMessageId` (`cmsg_…`).
2. The server (`sendMessage`) stored the message under a new server id (`m…`)
   and **published `message.created` to both participants — including the
   sender — before writing the HTTP 201 response**.
3. The sender's open `EventSource` therefore received the canonical message
   while the POST was still in flight. The stream handler called
   `upsertMessage`, which matched rows **by `id` only**. `cmsg_…` ≠ `m…`, so it
   appended a second row: optimistic (`sending`) + canonical (`sent`).
4. When the HTTP response finally arrived, `replaceOptimistic` swapped the
   optimistic row by `clientMessageId` and de-duplicated by `id`, so one copy
   disappeared "after some time".

The race is inherent — the stream is faster than the response on purpose — so
the fix is identity, not timing.

Contributing defects fixed at the same time:

- React keys used `message.id`, which changed from the client id to the server
  id → the bubble unmounted and remounted.
- `retry` generated a **new** `clientMessageId`, defeating the server's
  idempotency and able to store a second copy if the first attempt had in fact
  been persisted.
- `sendMedia` had no optimistic row and no de-duplication at all.
- `media.viewed` re-ran `openConversation`, which **replaced** the list and
  re-subscribed, dropping unsent messages.
- `markRead` only touched conversation bookkeeping; message `deliveryState`
  never advanced past `sent` in the UI, and `delivered` was never reported.

## 2. Identity and reconciliation model

A message has one **logical key**: `clientMessageId ?? id`.

- Messages this client sends always carry a `clientMessageId`; the server stores
  it and echoes it in every copy (stream, response, list). The key therefore
  never changes across the placeholder → canonical transition.
- Messages from the peer (or from another tab, once loaded from the server) are
  keyed by `id`.
- React keys use the same value (`messageKey()`), never array indexes.

Every write to `messages[conversationId]` goes through the pure functions in
`lib/domain/message-sync.ts` — the store never appends:

| Function | Rule |
| --- | --- |
| `applyOptimistic` | Insert a `sending` placeholder, or re-arm an existing `failed` row with the same key. Never overrides a canonical row. |
| `mergeMessage` / `mergeMessages` | Match by server `id`, else by `clientMessageId` (+ same sender). Canonical beats placeholder; among canonical copies, `deleted` is sticky, the newer `updatedAt` wins for content, and `deliveryState` **never moves backwards** (`DELIVERY_RANK`). Identical input returns the same array (no re-render). |
| `markSendFailed` | `sending → failed`, **only** if the row is still a placeholder — a late failure after the stream confirmed the message is ignored. |
| `applyDeliveryState` | Advance listed canonical ids; monotonic. |
| `applyReadWatermark` | Mark my messages at or before the peer's watermark as `read`. |
| `sortMessages` | `createdAt`, then key — deterministic for equal timestamps. |

The placeholder's `createdAt` is `max(now, newest + 1 ms)` so it always sorts
last even if the device clock trails; the server's timestamp replaces it on
reconciliation, so all clients agree on the final order.

### Sources that feed the merge

| Source | When | Note |
| --- | --- | --- |
| Optimistic placeholder | on send / retry | key = `clientMessageId` |
| `POST /messages` response | later | same key |
| SSE `message.created/updated/deleted/delivery` | any time | includes the sender's own copy |
| SSE `conversation.read` | peer read watermark | |
| Initial page / `loadOlderMessages` | open / scroll up | merged, not concatenated |
| Reconnect catch-up | every `onReady` after the first | latest page, plus `after:` tail if a full page was missed |

Reopening a conversation merges into the existing list instead of replacing it,
so unsent and failed rows survive.

## 3. Message state model

```
             POST accepted              recipient device synced       recipient saw it
 sending ───────────────▶ sent ───────────────────────▶ delivered ────────────────▶ read
    │
    │ POST failed (network / 4xx / 5xx)
    ▼
 failed ──── Retry (same clientMessageId) ────▶ sending
    │
    └──── Delete (discard) ────▶ removed locally
```

| State | Meaning (exact) | Set by | UI |
| --- | --- | --- | --- |
| `sending` | Placeholder exists only in the sender's browser; no server acknowledgement yet. | client | clock, bubble at 70 % opacity |
| `failed` | The send request failed (network error, timeout, 4xx/5xx). The server may or may not have stored it — that is why retry reuses the idempotency key. | client | red mark + "Not sent · Retry · Delete" |
| `sent` | The server persisted the message (HTTP 201 or `message.created`). | server | one grey tick |
| `delivered` | The **recipient's** client received the message — through the stream or a page fetch, whether or not it was on screen — and its `POST …/messages/delivery {state:'delivered'}` succeeded. | recipient → server | two grey ticks |
| `read` ("seen") | The recipient had the conversation open in a **visible** document and the bubble was rendered at least half inside the message viewport (IntersectionObserver), and the read watermark request succeeded. Being online, or having the tab open in the background, is not enough. | recipient → server | two blue ticks |

Server rules (`receipt-service.ts`, `lib/domain/message-policy.ts`):

- Only a participant may send receipts (`requireParticipant`); only the *other*
  participant can advance a message (`canMarkDelivered`), so a sender can never
  mark their own message delivered or read.
- Transitions are monotonic (`nextDeliveryState`); a stale or repeated receipt
  changes nothing, writes nothing and publishes nothing.
- Delivery receipts are batched (`messageIds[1..100]`, one Firestore batch).
- Read receipts use a **watermark**: `POST …/read {lastReadMessageAt}` advances
  every peer message at or before that instant that is still `sent`/`delivered`
  (bounded to 200 per request; older stragglers are picked up by the next
  watermark). The reader's `lastReadMessageAt` never moves backwards.
- The sender learns about receipts through `message.delivery` (exact ids that
  changed) and `conversation.read` (the watermark), both addressed to the
  sender only via `otherUserId`.

Client rules (`chat-store.ts`):

- `delivered` is queued for every peer message still in `sent` after a page
  load, a stream event or a reconnect, flushed in one request after 300 ms,
  never re-sent for ids in flight, and retried by the next sync if it failed
  (offline).
- `read` is reported per rendered peer bubble by `useSeenObserver`; the store
  coalesces reports into the **highest** watermark, sends it once, and never
  sends a lower one later (scrolling back up does not re-report).
- Received receipts are mirrored locally immediately, so ticks do not wait for
  a round trip.

## 4. Typing indicator

Transport: `POST /conversations/{id}/typing {isTyping}` → server verifies
participation → publishes `typing {userId, isTyping, at, otherUserId}` on the
in-process bus → the SSE route forwards it only to `otherUserId`. Nothing is
persisted, so nothing can leak through a read and nothing needs cleanup.

Sender (`createTypingPublisher`):

- Composer changes call `noteComposerActivity(hasContent)`.
- The first keystroke sends `true`; while typing continues it is repeated at
  most every **4 s** (heartbeat); **2.5 s** without input sends `false`.
- Immediate `false` on: send, composer cleared, leaving the conversation
  (unmount), page hidden, privacy lock (`stopAllTyping`).
- Ten keystrokes per second therefore cost ≈ 1 request per 4 s, not 10/s.

Receiver (`createTypingReceiver`):

- Shows the indicator on `true`; hides on `false`, when the peer's message
  arrives, or after **7 s** without a refresh (TTL) — so a sender whose tab was
  suspended, disconnected or closed mid-word cannot leave a permanent
  "typing…".
- The user's own echoed indicator (second tab) is ignored by `userId`.

Limitations: the indicator is best effort. If the sender's browser is suspended
before its `false` is sent, the receiver clears it by TTL (≤ 7 s). Two tabs of
the same user typing produce a single indicator on the peer's side (they are
the same user).

## 5. Hiding the chat

All paths call `hideChat(reason)` (`lib/client/privacy-lock.ts`), which in one
synchronous tick:

1. sets `privacy-locked` on `<html>` (CSS blurs any chat surface still painted),
2. flips the access store to locked → the shell renders the **typing game**,
3. wipes chat state (messages, conversations, streams, typing, receipts),
4. ends an active call,

and then revokes the server access session (`POST /access/lock`). The next
visit goes through the normal flow again: typing game → secret code → login or
re-authentication. A status refresh that was in flight when the lock happened is
ignored (`lockVersion`), so it cannot re-open the chat.

Triggers:

| Trigger | Where |
| --- | --- |
| **Hide** button (header of chat and of the conversation list) | `chat-screen.tsx`, `conversation-list.tsx` |
| **Double tap** on the message area | `useDoubleTap(listRef)` |
| Triple tap anywhere (kept) | `useTripleTap` |
| Hidden for > 60 s | `useInactivityLock` |
| Access session expired/revoked | `mt:access-required` |
| Settings → Lock now / Sign out | `settings/page.tsx` |

### Double-tap detector

Pointer events (touch, mouse, pen share one sequence, so a touch never fires a
second time through the compatibility `mousedown`/`click` events). A *tap* is a
primary-pointer press that ends within 300 ms and moves < 12 px; two taps count
when the second starts within 350 ms of the first ending and within 32 px. All
thresholds are options. Scrolls (movement), long presses, pinches (non-primary
pointers) and cancelled pointers never count and reset the sequence. Gestures
that start on interactive elements are ignored entirely: inputs, textareas,
buttons, links, selects, labels, audio/video controls, contenteditable, ARIA
buttons/links/menu items/options/sliders/textboxes/dialogs, and anything under
`data-no-hide-gesture` (the composer, the failed-message actions). Listeners are
passive; `touch-action: manipulation` on `<body>` removes the browser's own
double-tap zoom so the two cannot race. Browsers without `PointerEvent` fall
back to touch + mouse with a 700 ms suppression window after a touch.

### Inactivity rule (60 s hidden)

- Hidden = Page Visibility `hidden` (tab switched, window minimised, screen
  locked, app backgrounded). Signals: `visibilitychange`, `pagehide`/`pageshow`
  (bfcache), `freeze`/`resume` (Page Lifecycle).
- **Losing focus is not hiding.** `blur` is ignored; `focus` is only used to
  re-check an existing stamp. A visible chat next to another window keeps
  receiving messages, receipts and calls.
- On hide (only while the chat is unlocked): stamp `hiddenAt` in memory and in
  `sessionStorage`, stop outgoing typing, arm a 60 s timer.
- On any visible signal: compare `now − hiddenAt`; ≥ 60 s → `hideChat`, else
  clear the stamp and keep everything (conversation, scroll position, draft).
- On mount: a stamp left by a previous page lifetime (tab discarded/restored,
  reload while away) is evaluated before anything is painted; if it is too old
  the server session is revoked even though the tab already looks locked
  (`lock({force:true})`).

Why both a timer and a stamp: background tabs throttle timers and mobile
browsers suspend JavaScript entirely, so the timer may fire late or never. The
stamp comparison happens the instant the user returns, which is what makes the
rule reliable on phones.

### What is *not* guaranteed

- Background execution. While a tab is hidden the browser may throttle or
  suspend it; the app does not claim to receive messages or run the 60 s timer
  while suspended. It does guarantee that the chat is closed before it is shown
  again if the threshold has passed.
- Server-side revocation *while* suspended. Until the revoke request is sent
  the httpOnly access cookie stays valid up to its own TTL (30 min). A tab that
  is closed (not hidden) leaves no per-tab stamp; a new tab within the TTL
  restores the unlocked UI exactly as before this change.
- `pagehide` on iOS Safari is not always delivered on app switch; `freeze`/
  `visibilitychange` cover most cases, and the on-return stamp comparison covers
  the rest.

## 6. Security notes

- Nothing here relaxes authorisation: every receipt, typing ping and message
  read is validated server-side against the conversation's participants; the
  client's `deliveryState` values are never accepted as input (the server
  computes the next state itself).
- Receipts and typing indicators are addressed to the other participant only
  (`otherUserId`) and the SSE route drops anything not addressed to the viewer.
- Message content is never logged; receipt logs would contain ids only.
- Hiding the chat is a privacy feature layered on top of the access session,
  not the access control itself.
