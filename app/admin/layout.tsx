import { AdminGuard } from '@/components/admin/admin-guard';
import { AdminNav } from '@/components/admin/admin-nav';

export const metadata = { title: 'Administration · Keypad', robots: { index: false, follow: false } };

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <AdminGuard>
      <div className="min-h-dvh bg-surface-sunken">
        <AdminNav />
        <div className="mx-auto max-w-6xl px-4 py-6">{children}</div>
      </div>
    </AdminGuard>
  );
}
