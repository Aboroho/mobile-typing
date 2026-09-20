/**
 * Prisma client singleton.
 *
 * The module lazily imports `@prisma/client` so the DATA_PROVIDER=memory
 * (default for dev/tests) works without running `prisma generate` or having a
 * PostgreSQL server running. Production with DATA_PROVIDER=prisma requires
 * `prisma generate` to have been run (otherwise a clear error is thrown).
 */
import { env } from './env';
import { logger } from './logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _prisma: any = null;

async function loadPrismaClient(): Promise<any> {
  if (_prisma) return _prisma;
  try {
    const mod = await import('@prisma/client');
    const PrismaClient = mod.PrismaClient;
    if (!PrismaClient) throw new Error('@prisma/client did not export PrismaClient');
    _prisma = new PrismaClient({
      log: env().LOG_LEVEL === 'debug' ? ['query', 'warn', 'error'] : ['warn', 'error'],
    });
    _prisma.$on('error', (e: { message?: string; target?: string }) => {
      logger.error('prisma.error', { message: e.message, target: e.target });
    });
    return _prisma;
  } catch (err) {
    throw new Error(
      'DATA_PROVIDER=prisma requires Prisma Client to be generated. Run `npx prisma generate` ' +
        `after installing dependencies. Underlying error: ${(err as Error).message}`,
    );
  }
}

/**
 * Access to the PrismaClient. Only call this when DATA_PROVIDER=prisma is
 * configured (it is awaited lazily by the prisma data provider).
 */
export async function getPrisma(): Promise<any> {
  return loadPrismaClient();
}

// Re-export a synchronous getter for code paths that already know Prisma is
// available (e.g. inside the PrismaDataProvider which gated on loadPrismaClient).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function prismaSync(): any {
  if (!_prisma) {
    throw new Error('Prisma client not initialised. Await getPrisma() first.');
  }
  return _prisma;
}

export async function connectPrisma(): Promise<void> {
  const p = await loadPrismaClient();
  await p.$connect();
}

export async function disconnectPrisma(): Promise<void> {
  if (!_prisma) return;
  await _prisma.$disconnect();
}

// Export prisma as a lazy proxy so existing `import { prisma }` that never
// actually touch it (because DATA_PROVIDER=memory) don't crash at import time.
// Any real property access triggers the loader and throws if Prisma is missing.
export const prisma: any = new Proxy({} as unknown as { $connect: () => Promise<void>; $disconnect: () => Promise<void> }, {
  get(_target, prop) {
    if (!_prisma) {
      throw new Error(
        'Prisma client accessed before initialisation. DATA_PROVIDER must be set to "prisma" and getPrisma() awaited first.',
      );
    }
    return (_prisma as any)[prop];
  },
});
