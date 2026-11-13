import { useTranslation } from 'react-i18next';
import { StatusBadge, type StatusTone } from '@/shared/ui/status-badge';
import type { ClaimStatus } from '../types';

const TONES: Record<ClaimStatus, StatusTone> = {
  draft: 'neutral',
  submitted: 'info',
  query: 'warning',
  approved: 'success',
  rejected: 'danger',
  settled: 'success',
  written_off: 'neutral',
  cancelled: 'neutral',
};

/** A claim's state as colour, icon and word. */
export function ClaimStatusBadge({ status }: { status: ClaimStatus }) {
  const { t } = useTranslation('insurance');
  return <StatusBadge tone={TONES[status]} label={t(`claims.status.${status}`)} />;
}
