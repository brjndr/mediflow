import { ArrowUpCircle } from 'lucide-react';
import { StatusBadge } from '@/shared/ui/status-badge';

/** A token's priority: a word and an icon, never colour alone. */
export function PriorityBadge({ children }: { children: string }) {
  return <StatusBadge tone="warning" icon={ArrowUpCircle} label={children} />;
}
