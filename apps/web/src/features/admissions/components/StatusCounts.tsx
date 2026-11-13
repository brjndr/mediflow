import { useTranslation } from 'react-i18next';
import { cn } from '@/shared/lib/utils';
import { useOccupancy } from '../hooks/use-census';
import type { BoardBedStatus } from '../types';

/**
 * How many beds are in each status, for the ward chosen or every ward. Each count is a button
 * that picks that status on the board (pressed again, all statuses), so the numbers and the
 * list or map below them are always the same beds.
 */
export function StatusCounts({
  wardId,
  live,
  status,
  onSelect,
}: {
  wardId: string;
  live: boolean;
  status: BoardBedStatus | '';
  onSelect: (status: BoardBedStatus | '') => void;
}) {
  const { t } = useTranslation('admissions');
  const occupancy = useOccupancy(wardId, live);
  if (occupancy.isError) return null;
  return (
    <ul aria-label={t('counts.label')} className="flex flex-wrap gap-2">
      {occupancy.counts.map(({ status: each, count }) => (
        <li key={each}>
          <button
            type="button"
            aria-pressed={status === each}
            onClick={() => onSelect(status === each ? '' : each)}
            className={cn(
              'flex min-w-28 flex-col items-start rounded-md border bg-card px-3 py-2 text-start text-sm pointer-coarse:min-h-11',
              status === each && 'border-primary bg-accent text-accent-foreground',
            )}
          >
            <span className="text-xl font-semibold tabular-nums">
              {occupancy.isPending ? '–' : count}
            </span>
            <span>{t(`status.${each}`)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
