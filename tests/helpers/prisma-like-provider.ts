/**
 * Test helper: asserts the in-memory DataProvider keeps production
 * (PostgreSQL/Prisma) semantics for the Argon2 hash.
 *
 * The Prisma provider (`lib/data/prisma/index.ts`) stores the password hash in
 * the `User.passwordHash` column and maps every row through `mapUser()`, which
 * deliberately does **not** include `passwordHash` on the returned
 * `UserRecord`. The signup false-error bug was only visible against PostgreSQL
 * because the in-memory provider used to keep the hash on the record itself,
 * so code that read the hash off a `UserRecord` "worked" in tests.
 *
 * The memory provider now keeps hashes in their own collection, matching
 * production. This wrapper stays as a guard: it re-checks every record handed
 * back to services and fails loudly if a hash ever leaks onto one again.
 */
import { getData } from '@/lib/data';
import type { DataProvider, UserRecord, UserRepo } from '@/lib/data/types';

/** Fields `mapUser()` in the Prisma provider returns — nothing else is allowed. */
function toPrismaShapedRecord(record: UserRecord | null): UserRecord | null {
  if (!record) return null;
  if ('passwordHash' in (record as unknown as Record<string, unknown>)) {
    throw new Error(
      'password hash leaked onto a UserRecord — providers must keep it in its own column ' +
        '(this is what made a successful signup report "cannot create account")',
    );
  }
  return {
    id: record.id,
    name: record.name,
    email: record.email,
    photoUrl: record.photoUrl,
    status: record.status,
    lastLoginAt: record.lastLoginAt,
    isAdmin: record.isAdmin,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    disabledReason: record.disabledReason,
  };
}

/** A `UserRepo` that guarantees records are shaped exactly like Prisma's. */
export class PrismaLikeUsers implements UserRepo {
  constructor(private readonly inner: UserRepo) {}

  create = async (record: UserRecord) => toPrismaShapedRecord(await this.inner.create(record))!;
  createWithPasswordHash = async (record: UserRecord, passwordHash: string) =>
    toPrismaShapedRecord(await this.inner.createWithPasswordHash(record, passwordHash))!;
  getPasswordHash = (userId: string) => this.inner.getPasswordHash(userId);
  getById = async (userId: string) => toPrismaShapedRecord(await this.inner.getById(userId));
  getByEmail = async (email: string) => toPrismaShapedRecord(await this.inner.getByEmail(email));
  update = async (userId: string, patch: Partial<UserRecord>) =>
    toPrismaShapedRecord(await this.inner.update(userId, patch));
  list = (params: Parameters<UserRepo['list']>[0]) => this.inner.list(params);
  search = (q: string, limit: number) => this.inner.search(q, limit);
  countByStatus = () => this.inner.countByStatus();
  touchLogin = (userId: string, at: string) => this.inner.touchLogin(userId, at);
}

/**
 * Wraps `users` on the cached provider. Returns the wrapper so tests can reach
 * the underlying repo when they need to inspect stored state.
 */
export async function installPrismaLikeUsers(): Promise<PrismaLikeUsers> {
  const data: DataProvider = await getData();
  if (data.users instanceof PrismaLikeUsers) return data.users;
  const wrapped = new PrismaLikeUsers(data.users);
  data.users = wrapped;
  return wrapped;
}
