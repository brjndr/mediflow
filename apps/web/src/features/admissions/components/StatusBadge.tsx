import { Ban, BedDouble, CircleCheck, SprayCan } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { BoardBed, BoardBedStatus } from '../types';

const ICONS = {
  available: CircleCheck,
  occupied: BedDouble,
  cleaning: SprayCan,
  blocked: Ban,
} as const satisfies Record<BoardBedStatus, unknown>;

const TONES: Record<BoardBedStatus, string> = {
  available: 'border-emerald-600/40 text-emerald-800 dark:text-emerald-300',
  occupied: 'border-sky-600/40 text-sky-800 dark:text-sky-300',
  cleaning: 'border-amber-600/40 text-amber-800 dark:text-amber-300',
  blocked: 'border-rose-600/40 text-rose-800 dark:text-rose-300',
};

/** A bed's status in a word and an icon, never colour alone. A blocked bed says why. */
export function StatusBadge({ bed }: { bed: BoardBed }) {
  const { t } = useTranslation('admissions');
  const Icon = ICONS[bed.status];
  const text =
    bed.status === 'blocked' && bed.blockedReason
      ? t('status.blockedFor', { reason: t(`reasons.${bed.blockedReason}`) })
      : t(`status.${bed.status}`);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-sm ${TONES[bed.status]}`}
    >
      <Icon aria-hidden="true" className="size-4" />
      {text}
    </span>
  );
}
