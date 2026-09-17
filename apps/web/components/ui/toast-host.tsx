'use client';

import { cn } from './cn';
import { useUiStore } from '@/stores/ui-store';

export function ToastHost() {
  const toasts = useUiStore((state) => state.toasts);
  const dismiss = useUiStore((state) => state.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 safe-bottom"
    >
      {toasts.map((toast) => (
        <button
          key={toast.id}
          type="button"
          onClick={() => dismiss(toast.id)}
          className={cn(
            'pointer-events-auto w-full max-w-sm rounded-xl px-4 py-3 text-left text-sm shadow-lg animate-slide-up',
            toast.tone === 'error' && 'bg-danger text-white',
            toast.tone === 'success' && 'bg-success text-white',
            toast.tone === 'info' && 'bg-ink text-surface',
          )}
        >
          {toast.message}
        </button>
      ))}
    </div>
  );
}
