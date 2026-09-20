/**
 * Runtime shim for embedding Next.js in a plain Node server.
 *
 * Next's server runtime resolves `globalThis.AsyncLocalStorage` at module load
 * (`next/dist/server/app-render/async-local-storage.js`) and silently falls
 * back to a stub that throws `E504: AsyncLocalStorage accessed in runtime where
 * it is not available` on the first `run()`/`disable()`. The `next` CLI sets
 * that global before it loads the server; a custom server (`server.ts`) does
 * not, so every render crashed with an invariant error that looked nothing like
 * a missing global.
 *
 * This module must be imported **before** `next` so the assignment happens
 * first — ESM evaluates imports in source order.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const target = globalThis as { AsyncLocalStorage?: unknown };
if (!target.AsyncLocalStorage) target.AsyncLocalStorage = AsyncLocalStorage;

export {};
