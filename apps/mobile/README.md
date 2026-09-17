# React Native client (future)

This workspace exists so the shared packages have an obvious home when a native
app is added. Nothing is implemented here yet — and nothing needs to be
duplicated when it is.

## What is already reusable

| Package           | Reuse in React Native                                    |
| ----------------- | -------------------------------------------------------- |
| `@mt/types`       | Domain types and product limits (pure TypeScript).       |
| `@mt/validation`  | Zod schemas for every request body (pure).               |
| `@mt/domain`      | Business rules: secret-code buffer, scoring, edit window, view-once state machine, media validation (pure). |
| `@mt/api-client`  | Typed HTTP client — pass `fetchImpl` and a token provider. |
| `@mt/utils`       | Hashing, ids, time formatting (uses `crypto.subtle`).    |

## What must be re-implemented

- The UI (React Native components instead of Tailwind/HTML).
- `lib/browser/*` equivalents: `AsyncStorage`-backed keystroke buffer, an app
  state listener instead of the Page Visibility API, `react-native-webrtc`
  instead of the browser `RTCPeerConnection`.
- Secure storage for the session token (`expo-secure-store` / Keychain) instead
  of an httpOnly cookie.

## Suggested first step

```bash
npx create-expo-app apps/mobile --template expo-template-blank-typescript
```

Then add the workspace packages to its dependencies and build screens directly on
top of `createApiClient()`: every route, error code and payload is already typed.
