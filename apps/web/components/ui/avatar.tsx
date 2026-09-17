import { initials } from '@mt/utils';
import { cn } from './cn';

export interface AvatarProps {
  name: string;
  src?: string | null;
  size?: 'sm' | 'md' | 'lg';
  online?: boolean;
  className?: string;
}

const SIZES = { sm: 'h-9 w-9 text-xs', md: 'h-12 w-12 text-sm', lg: 'h-20 w-20 text-xl' } as const;

export function Avatar({ name, src, size = 'md', online, className }: AvatarProps) {
  return (
    <span className={cn('relative inline-flex shrink-0', className)}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- user avatars come from an authorised route
        <img src={src} alt="" className={cn('rounded-full object-cover', SIZES[size])} />
      ) : (
        <span
          aria-hidden
          className={cn(
            'flex items-center justify-center rounded-full bg-brand-soft font-semibold text-brand-strong',
            SIZES[size],
          )}
        >
          {initials(name)}
        </span>
      )}
      {online ? (
        <span className="absolute bottom-0 right-0 h-3 w-3 rounded-full border-2 border-surface bg-success" />
      ) : null}
    </span>
  );
}
