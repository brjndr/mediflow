import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import type { SlotProps } from '@/registry';
import { AmendmentsList } from './AmendmentsList';

/**
 * The amendments of one visit (`encounter.detail.actions`, #1181), for `correction:read`: shown
 * under the visit's actions when an approved correction was added to it, and nothing at all
 * otherwise. Given ids and the status only.
 */
export default function EncounterAmendments({ context }: SlotProps) {
  const { t } = useTranslation('records');
  const canRead = usePermission('correction:read');
  const { encounterId, patientId } = context ?? {};
  if (!canRead || typeof encounterId !== 'string' || typeof patientId !== 'string') return null;
  return (
    <div className="basis-full">
      {/* Keyed by the visit: another visit's amendments are never carried over. */}
      <AmendmentsList
        key={encounterId}
        patientId={patientId}
        target={{ kind: 'encounter', id: encounterId }}
        label={t('amendments.visit')}
        quiet
      />
    </div>
  );
}
