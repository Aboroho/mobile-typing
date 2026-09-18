'use client';

import { ArrowLeft, LogOut, Lock, Moon, Sun, User as UserIcon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/stores/auth-store';
import { useAccessStore } from '@/stores/access-store';
import { useUiStore } from '@/stores/ui-store';
import { disconnectAllStreams } from '@/stores/chat-store';
import { endCallForPrivacyLock } from '@/stores/call-store';

export default function SettingsPage() {
  const router = useRouter();
  const user = useAuthStore((state) => state.user);
  const logout = useAuthStore((state) => state.logout);
  const lock = useAccessStore((state) => state.lock);
  const theme = useUiStore((state) => state.theme);
  const toggleTheme = useUiStore((state) => state.toggleTheme);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col gap-3 px-4 py-6">
      <header className="flex items-center gap-2">
        <Link href="/conversations" aria-label="Back" className="rounded-full p-2 text-ink-muted hover:bg-surface-raised">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-lg font-semibold">Settings</h1>
      </header>

      <section className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface-raised">
        <Link href="/profile" className="flex items-center gap-3 px-4 py-3 hover:bg-surface-sunken">
          <UserIcon className="h-5 w-5 text-ink-muted" />
          <span className="flex-1">
            <span className="block text-sm font-medium">Profile</span>
            <span className="block text-xs text-ink-muted">{user?.email}</span>
          </span>
        </Link>
        <button
          type="button"
          onClick={toggleTheme}
          className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-sunken"
        >
          {theme === 'dark' ? <Sun className="h-5 w-5 text-ink-muted" /> : <Moon className="h-5 w-5 text-ink-muted" />}
          <span className="flex-1">
            <span className="block text-sm font-medium">Appearance</span>
            <span className="block text-xs text-ink-muted">{theme === 'dark' ? 'Dark' : 'Light'}</span>
          </span>
        </button>
        <button
          type="button"
          onClick={async () => {
            disconnectAllStreams();
            await endCallForPrivacyLock();
            await lock();
            router.replace('/');
          }}
          className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-sunken"
        >
          <Lock className="h-5 w-5 text-ink-muted" />
          <span className="flex-1">
            <span className="block text-sm font-medium">Lock now</span>
            <span className="block text-xs text-ink-muted">Return to the typing test</span>
          </span>
        </button>
        <button
          type="button"
          onClick={async () => {
            disconnectAllStreams();
            await endCallForPrivacyLock();
            // logout clears access state as well as the Firebase session.
            // Locking again can erase the next challenge after the guard has
            // already returned the browser to the typing game.
            await logout();
            router.replace('/');
          }}
          className="flex w-full items-center gap-3 px-4 py-3 text-left text-danger hover:bg-danger/5"
        >
          <LogOut className="h-5 w-5" />
          <span className="text-sm font-medium">Sign out</span>
        </button>
      </section>

      <p className="px-2 text-[11px] text-ink-faint">
        The app locks automatically when this tab is hidden or minimised.
      </p>
    </main>
  );
}
