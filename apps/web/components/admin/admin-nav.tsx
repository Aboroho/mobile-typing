'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Activity, Images, KeyRound, MessagesSquare, Phone, ShieldCheck, Users } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { useAuthStore } from '@/stores/auth-store';
import { useAccessStore } from '@/stores/access-store';

const LINKS = [
  { href: '/admin/dashboard', label: 'Dashboard', icon: Activity },
  { href: '/admin/users', label: 'Users', icon: Users },
  { href: '/admin/conversations', label: 'Conversations', icon: MessagesSquare },
  { href: '/admin/media', label: 'Media', icon: Images },
  { href: '/admin/calls', label: 'Calls', icon: Phone },
  { href: '/admin/settings', label: 'Secret code & audit', icon: KeyRound },
];

export function AdminNav() {
  const pathname = usePathname();
  const user = useAuthStore((state) => state.user);
  const lock = useAccessStore((state) => state.lock);
  void lock;

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <ShieldCheck className="h-4 w-4 text-brand" />
          Administration
        </span>
        <span className="hidden text-xs text-ink-muted sm:inline">{user?.email}</span>
        <nav className="ml-auto flex flex-wrap items-center gap-1">
          {LINKS.map((link) => {
            const active = pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={cn(
                  'flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-colors',
                  active ? 'bg-brand-soft text-brand-strong' : 'text-ink-muted hover:bg-surface-raised',
                )}
              >
                <link.icon className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{link.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}
