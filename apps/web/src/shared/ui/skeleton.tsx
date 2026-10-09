import type { ComponentProps } from 'react';
import { cn } from '@/shared/lib/utils';

/**
 * A grey placeholder in the shape of content that is loading. Decorative: pair it with a
 * `role="status"` label (see PageSkeleton) so assistive technology hears that something loads.
 */
export function Skeleton({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      aria-hidden
      className={cn('rounded-md bg-accent motion-safe:animate-pulse', className)}
      {...props}
    />
  );
}
