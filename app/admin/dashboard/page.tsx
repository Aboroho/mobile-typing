'use client';

import { useEffect, useState } from 'react';
import { Activity, Images, MessagesSquare, Phone, Trash2, Users } from 'lucide-react';
import type { Dashboard } from '@mt/types';
import { api } from '@/lib/client/api';
import { StatCard } from '@/components/admin/stat-card';
import { Badge } from '@/components/ui/badge';

export default function AdminDashboardPage() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.admin
      .dashboard()
      .then((result) => setDashboard(result.dashboard))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'failed to load'));
  }, []);

  if (error) return <p className="rounded-xl bg-danger/10 px-4 py-3 text-sm text-danger">{error}</p>;
  if (!dashboard) return <p className="text-sm text-ink-muted">Loading dashboard…</p>;

  const { stats } = dashboard;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard icon={Users} label="Users" value={stats.totalUsers} hint={`${stats.activeUsers} active · ${stats.disabledUsers} disabled`} />
        <StatCard icon={MessagesSquare} label="Conversations" value={stats.conversations} />
        <StatCard icon={MessagesSquare} label="Messages" value={stats.messages} hint={`${stats.last24hMessages} in the last 24h`} />
        <StatCard icon={Trash2} label="Deleted messages" value={stats.deletedMessages} hint="soft deleted, still inspectable" />
        <StatCard icon={Images} label="Media" value={stats.media} hint={`${stats.viewOnceMedia} view once`} />
        <StatCard icon={Trash2} label="Deleted media" value={stats.deletedMedia} />
        <StatCard icon={Phone} label="Calls" value={stats.calls} />
        <StatCard icon={Activity} label="Typing sessions" value={stats.typingSessions} hint="public game plays" />
      </div>

      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="mb-3 text-sm font-semibold">Recent activity</h2>
        <ul className="divide-y divide-line">
          {dashboard.recent.map((item) => (
            <li key={item.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm">{item.title}</p>
                <p className="truncate text-xs text-ink-muted">{item.description}</p>
              </div>
              <Badge tone={item.kind === 'audit' ? 'warning' : 'neutral'}>{item.kind}</Badge>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
