export function nowIso(): string {
  return new Date().toISOString();
}

export function nowMs(): number {
  return Date.now();
}

export function toMs(value: string | number | Date): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

export function toIso(value: string | number | Date): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return new Date(value).toISOString();
  return new Date(value).toISOString();
}

export function addMs(value: string | number | Date, ms: number): string {
  return new Date(toMs(value) + ms).toISOString();
}

export function diffMs(a: string | number | Date, b: string | number | Date): number {
  return toMs(a) - toMs(b);
}

export function formatClock(value: string | number | Date): string {
  const date = new Date(toMs(value));
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatRelative(value: string | number | Date, now: number = Date.now()): string {
  const delta = now - toMs(value);
  if (delta < 45_000) return 'just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return new Date(toMs(value)).toLocaleDateString();
}

export function isSameDay(a: string | number | Date, b: string | number | Date): boolean {
  const da = new Date(toMs(a));
  const db = new Date(toMs(b));
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

/** `m:ss` — used for call timers and voice message playback. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
