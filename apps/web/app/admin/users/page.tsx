'use client';

import { useEffect, useState } from 'react';
import { Search } from 'lucide-react';
import type { AdminUserRow } from '@mt/types';
import { api } from '@/lib/client/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useUiStore } from '@/stores/ui-store';
import { errorMessage } from '@/stores/access-store';

export default function AdminUsersPage() {
  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = async (q: string) => {
    const result = await api.admin.users({ q: q || undefined, limit: 50 });
    setUsers(result.items);
  };

  useEffect(() => {
    void load('');
  }, []);

  const toggleStatus = async (user: AdminUserRow) => {
    const next = user.status === 'disabled' ? 'active' : 'disabled';
    setBusyId(user.id);
    try {
      await api.admin.updateUserStatus(user.id, next, 'changed from the admin panel');
      await load(query);
      useUiStore.getState().pushToast(`${user.name} is now ${next}`, 'success');
    } catch (error) {
      useUiStore.getState().pushToast(errorMessage(error), 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-ink-faint" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void load(query);
          }}
          placeholder="Search by name or email prefix"
          className="pl-9"
          data-secret-ignore="true"
        />
      </div>

      <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-xs uppercase tracking-wide text-ink-faint">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Email</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Last login</th>
              <th className="px-3 py-2">Admin</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {users.map((user) => (
              <tr key={user.id}>
                <td className="px-3 py-2 font-medium">{user.name}</td>
                <td className="px-3 py-2 text-ink-muted">{user.email}</td>
                <td className="px-3 py-2">
                  <Badge tone={user.status === 'active' ? 'success' : 'danger'}>{user.status}</Badge>
                </td>
                <td className="px-3 py-2 text-xs text-ink-muted">{user.lastLoginAt ?? '—'}</td>
                <td className="px-3 py-2">{user.isAdmin ? <Badge tone="warning">admin</Badge> : null}</td>
                <td className="px-3 py-2 text-right">
                  <Button size="sm" variant="secondary" disabled={busyId === user.id} onClick={() => void toggleStatus(user)}>
                    {user.status === 'active' ? 'Disable' : 'Reactivate'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 ? <p className="px-3 py-6 text-center text-sm text-ink-muted">No users found.</p> : null}
      </div>
    </div>
  );
}
