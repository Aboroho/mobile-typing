'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAccessStore } from '@/stores/access-store';
import { useAuthStore } from '@/stores/auth-store';

/**
 * Client-side route guard for the private area.
 *
 * It redirects to `/` (the typing game) when the browser has no access session
 * or no authenticated user. It is a UX guard only — every API route re-checks
 * both independently.
 */
export function RequireAccess({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const unlocked = useAccessStore((state) => state.unlocked);
  const user = useAuthStore((state) => state.user);
  const initializing = useAuthStore((state) => state.initializing);

  useEffect(() => {
    if (!unlocked || (!initializing && !user)) {
      router.replace('/');
    }
  }, [unlocked, user, initializing, router]);

  if (!unlocked || initializing || !user) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <span className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-brand" />
      </main>
    );
  }
  return <>{children}</>;
}
