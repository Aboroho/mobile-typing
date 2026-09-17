'use client';

import { useEffect, useState } from 'react';
import { formatBytes, formatDuration } from '@mt/utils';
import type { MediaForAdmin } from '@mt/types';
import { api } from '@/lib/client/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SegmentedControl } from '@/components/ui/segmented-control';

type Filter = 'all' | 'image' | 'voice' | 'view-once' | 'deleted';

export default function AdminMediaPage() {
  const [media, setMedia] = useState<MediaForAdmin[]>([]);
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    void api.admin
      .media({
        kind: filter === 'image' || filter === 'voice' ? filter : undefined,
        viewOnceOnly: filter === 'view-once' ? true : undefined,
        includeDeleted: filter === 'deleted' ? true : false,
        limit: 60,
      })
      .then((result) => setMedia(result.items))
      .catch(() => setMedia([]));
  }, [filter]);

  return (
    <div className="space-y-4">
      <SegmentedControl
        label="Media filter"
        value={filter}
        onChange={(value) => setFilter(value)}
        options={[
          { value: 'all', label: 'All' },
          { value: 'image', label: 'Images' },
          { value: 'voice', label: 'Voice' },
          { value: 'view-once', label: 'View once' },
          { value: 'deleted', label: 'Deleted' },
        ]}
        className="max-w-xl"
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {media.map((item) => (
          <article key={item.id} className="overflow-hidden rounded-2xl border border-line bg-surface">
            <div className="relative aspect-square bg-surface-sunken">
              {item.kind === 'image' ? (
                // eslint-disable-next-line @next/next/no-img-element -- authorised admin route
                <img
                  src={api.admin.mediaContent(item.id)}
                  alt=""
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              ) : (
                <audio controls src={api.admin.mediaContent(item.id)} className="absolute inset-x-2 bottom-2 h-8" />
              )}
              <span className="absolute left-2 top-2">
                <Badge tone={item.deleted ? 'danger' : item.viewOnce ? 'warning' : 'neutral'}>
                  {item.deleted ? 'deleted' : item.viewOnce ? (item.viewOnceState ?? 'view once') : item.kind}
                </Badge>
              </span>
            </div>
            <div className="space-y-1 p-2 text-[11px] text-ink-muted">
              <p className="truncate">{item.mimeType}</p>
              <p>
                {formatBytes(item.sizeBytes)}
                {item.durationMs ? ` · ${formatDuration(item.durationMs)}` : ''}
              </p>
              {item.viewedAt ? <p>viewed {new Date(item.viewedAt).toLocaleString()}</p> : null}
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-[11px]"
                onClick={() => window.open(api.admin.mediaContent(item.id), '_blank', 'noopener')}
              >
                Download (audited)
              </Button>
            </div>
          </article>
        ))}
      </div>
      {media.length === 0 ? <p className="text-sm text-ink-muted">No media matches this filter.</p> : null}
      <p className="text-[11px] text-ink-faint">
        Opening or downloading media here is written to the audit log. Soft deleted files are retained by design.
      </p>
    </div>
  );
}
