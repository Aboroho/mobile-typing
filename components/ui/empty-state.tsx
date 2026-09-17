import type { LucideIcon } from 'lucide-react';

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <span className="rounded-full bg-surface-sunken p-3 text-ink-faint">
        <Icon className="h-6 w-6" />
      </span>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {description ? <p className="max-w-xs text-xs text-ink-muted">{description}</p> : null}
      {action}
    </div>
  );
}
