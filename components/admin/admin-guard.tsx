'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth-store';
import { useAccessStore } from '@/stores/access-store';

/**
 * Client-side admin gate. The authoritative check is server side
 * (`requireAdminAccess` on every `/api/v1/admin/*` route); this only avoids
 * flashing the panel to a non-administrator.
 */
export function AdminGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const initializing = useAuthStore((state) => state.initializing);
  const unlocked = useAccessStore((state) => state.unlocked);

  useEffect(() => {
    if (!unlocked || (!initializing && !user)) router.replace('/');
    else if (!initializing && user && !user.isAdmin) router.replace('/conversations');
  }, [unlocked, user, initializing, router]);

  if (initializing || !user?.isAdmin || !unlocked) {
    return (
      <main className="flex min-h-dvh items-center justify-center text-sm text-ink-muted">
        Checking administrator access…
      </main>
    );
  }
  return <>{children}</>;
}
