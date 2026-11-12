import {
  Circle,
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/shared/lib/utils';

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const TONES: Record<StatusTone, { className: string; icon: LucideIcon }> = {
  success: { className: 'bg-success-soft text-success-soft-foreground', icon: CircleCheck },
  warning: { className: 'bg-warning-soft text-warning-soft-foreground', icon: TriangleAlert },
  danger: { className: 'bg-destructive-soft text-destructive-soft-foreground', icon: CircleAlert },
  info: { className: 'bg-info-soft text-info-soft-foreground', icon: Info },
  neutral: { className: 'bg-muted text-muted-foreground', icon: Circle },
};

interface StatusBadgeProps extends Omit<ComponentProps<'span'>, 'children'> {
  tone: StatusTone;
  /** Already translated. The word is always shown: colour is never the only signal. */
  label: string;
  /** Replaces the tone's icon when another says it better (a bed, a sample). */
  icon?: LucideIcon;
}

/** A status as colour, icon and word. */
export function StatusBadge({ tone, label, icon, className, ...props }: StatusBadgeProps) {
  const Icon = icon ?? TONES[tone].icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-medium',
        TONES[tone].className,
        className,
      )}
      {...props}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      {label}
    </span>
  );
}
