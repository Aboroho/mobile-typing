'use client';

import { useEffect, useState } from 'react';
import { Eye, EyeOff, ImageIcon } from 'lucide-react';
import type { MediaView } from '@mt/types';
import { formatBytes } from '@mt/utils';
import { api } from '@/lib/client/api';
import { cn } from '@/components/ui/cn';
import { useUiStore } from '@/stores/ui-store';
import { errorMessage } from '@/stores/access-store';

/**
 * Image bubble.
 *
 * View-once images are never rendered until the recipient explicitly opens them;
 * the claim happens server side (`POST /media/{id}/view`) and the bytes are
 * cleared from the DOM as soon as the viewer closes the overlay.
 */
export function ImageMessage({
  media,
  own,
  onOpenViewOnce,
}: {
  media: MediaView;
  own: boolean;
  onOpenViewOnce?: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (media.deleted) {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-surface-sunken px-3 py-3 text-xs text-ink-muted">
        <EyeOff className="h-4 w-4" />
        This photo was deleted
      </div>
    );
  }

  if (media.viewOnce) {
    return (
      <button
        type="button"
        onClick={async () => {
          if (own) {
            setOpen(true);
            return;
          }
          if (media.viewOnceState === 'viewed') {
            useUiStore.getState().pushToast('This photo has already been viewed', 'info');
            return;
          }
          try {
            await api.media.openViewOnce(media.mediaId);
            setOpen(true);
          } catch (error) {
            useUiStore.getState().pushToast(errorMessage(error), 'error');
          }
        }}
        className="flex w-full flex-col items-start gap-2 rounded-xl bg-surface-sunken px-3 py-3 text-left"
      >
        <span className="flex items-center gap-2 text-xs font-medium text-ink">
          <Eye className="h-4 w-4 text-brand" />
          {media.viewOnceState === 'viewed' ? 'Photo opened' : 'Tap to view photo once'}
        </span>
        <span className="text-[11px] text-ink-faint">{formatBytes(media.sizeBytes)}</span>
      </button>
    );
  }

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="block w-full overflow-hidden rounded-xl">
        {media.contentUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- served from an authorised route
          <img
            src={media.contentUrl}
            alt={own ? 'Photo you sent' : 'Received photo'}
            loading="lazy"
            decoding="async"
            className="max-h-72 w-full object-cover"
          />
        ) : (
          <span className="flex h-32 w-full items-center justify-center bg-surface-sunken text-ink-faint">
            <ImageIcon className="h-6 w-6" />
          </span>
        )}
      </button>
      {open ? <Lightbox url={media.contentUrl} onClose={() => setOpen(false)} onOpened={onOpenViewOnce} /> : null}
    </>
  );
}

/** Full screen preview. Cleared from the DOM on close so nothing lingers. */
export function Lightbox({
  url,
  onClose,
  onOpened,
}: {
  url: string | null;
  onClose: () => void;
  onOpened?: () => void;
}) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    setVisible(false);
    // Slight delay keeps the fade from flashing an empty frame.
    setTimeout(() => {
      onClose();
      onOpened?.();
    }, 120);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Photo preview"
      onClick={close}
      onContextMenu={(event) => event.preventDefault()}
      className={cn(
        'fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 transition-opacity',
        visible ? 'opacity-100' : 'opacity-0',
      )}
    >
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- authorised route, never cached
        <img src={url} alt="" className="max-h-full max-w-full select-none object-contain" draggable={false} />
      ) : (
        <p className="text-sm text-white/80">This photo is no longer available.</p>
      )}
    </div>
  );
}
