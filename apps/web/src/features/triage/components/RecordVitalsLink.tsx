import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { SlotProps } from '@/registry';
import { secondaryLink } from '@/shared/ui/button';

/** Tokens whose patient is still to be seen: triage comes before the consultation. */
const OPEN = new Set(['waiting', 'called']);

/**
 * "Record vitals" on a token of the queue board (`queue.row.actions`), given the token's id, its
 * number, its status and its patient's id. Rendered for every row, so it reads no data: whether
 * vitals were taken already is said on the form.
 */
export default function RecordVitalsLink({ context }: SlotProps) {
  const { t } = useTranslation('triage');
  const { tokenId, patientId, number, status } = context ?? {};
  if (typeof tokenId !== 'string' || typeof patientId !== 'string' || !OPEN.has(String(status))) {
    return null;
  }
  return (
    <Link
      to={`/triage/${patientId}?token=${tokenId}`}
      aria-label={t('rowActionLabel', { number })}
      className={secondaryLink}
    >
      {t('rowAction')}
    </Link>
  );
}
