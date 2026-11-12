import { Ban, BedDouble, CircleCheck, SprayCan } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { StatusBadge as Badge, type StatusTone } from '@/shared/ui/status-badge';
import type { BoardBed, BoardBedStatus } from '../types';

const ICONS = {
  available: CircleCheck,
  occupied: BedDouble,
  cleaning: SprayCan,
  blocked: Ban,
} as const satisfies Record<BoardBedStatus, unknown>;

const TONES: Record<BoardBedStatus, StatusTone> = {
  available: 'success',
  occupied: 'info',
  cleaning: 'warning',
  blocked: 'danger',
};

/** A bed's status in a word and an icon, never colour alone. A blocked bed says why. */
export function StatusBadge({ bed }: { bed: BoardBed }) {
  const { t } = useTranslation('admissions');
  const text =
    bed.status === 'blocked' && bed.blockedReason
      ? t('status.blockedFor', { reason: t(`reasons.${bed.blockedReason}`) })
      : t(`status.${bed.status}`);
  return <Badge tone={TONES[bed.status]} icon={ICONS[bed.status]} label={text} />;
}
