'use client';

import { useEffect, useState } from 'react';
import { formatDuration } from '@mt/utils';
import type { CallView } from '@mt/types';
import { api } from '@/lib/client/api';
import { Badge } from '@/components/ui/badge';

export default function AdminCallsPage() {
  const [calls, setCalls] = useState<CallView[]>([]);

  useEffect(() => {
    void api.admin
      .calls({ limit: 50 })
      .then((result) => setCalls(result.items))
      .catch(() => setCalls([]));
  }, []);

  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-line text-xs uppercase tracking-wide text-ink-faint">
          <tr>
            <th className="px-3 py-2">Started</th>
            <th className="px-3 py-2">Initiator</th>
            <th className="px-3 py-2">Recipient</th>
            <th className="px-3 py-2">Status</th>
            <th className="px-3 py-2">Duration</th>
            <th className="px-3 py-2">End reason</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {calls.map((call) => (
            <tr key={call.id}>
              <td className="px-3 py-2 text-xs">{new Date(call.createdAt).toLocaleString()}</td>
              <td className="px-3 py-2 font-mono text-xs">{call.initiatorId.slice(0, 14)}</td>
              <td className="px-3 py-2 font-mono text-xs">{call.recipientId.slice(0, 14)}</td>
              <td className="px-3 py-2">
                <Badge tone={call.status === 'ended' ? 'success' : call.status === 'missed' ? 'danger' : 'neutral'}>
                  {call.status}
                </Badge>
              </td>
              <td className="px-3 py-2 tabular-nums">{call.durationMs ? formatDuration(call.durationMs) : '—'}</td>
              <td className="px-3 py-2 text-xs text-ink-muted">{call.endReason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {calls.length === 0 ? <p className="px-3 py-6 text-center text-sm text-ink-muted">No calls recorded yet.</p> : null}
    </div>
  );
}
