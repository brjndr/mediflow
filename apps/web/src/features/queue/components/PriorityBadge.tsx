import { ArrowUpCircle } from 'lucide-react';
import type { ReactNode } from 'react';

/** A token's priority: a word and an icon, never colour alone. */
export function PriorityBadge({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900">
      <ArrowUpCircle aria-hidden="true" className="size-3.5" />
      {children}
    </span>
  );
}
