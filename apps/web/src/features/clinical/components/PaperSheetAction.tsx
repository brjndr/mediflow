import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFeatureFlag, usePermission } from '@/access';
import { useSession } from '@/app/session';
import type { SlotProps } from '@/registry';
import { Button } from '@/shared/ui/button';
import { useTenant } from '@/tenancy';
import { useEncounter } from '../hooks/use-clinical';
import { PaperDialog } from './PaperDialog';
import { setPaperDialog } from './paper-dialog-store';

/**
 * "Attach OPD sheet" (#1202) on a queue token (`queue.row.actions`) and on a visit
 * (`encounter.detail.actions`), for `encounter:recordPaper`, given ids and values only. A row of
 * the queue reads nothing: it asks the board's dialog (`PaperSheetHost`) to open. Attaching also
 * needs `document:upload`, `patient:read` and the documents module, as on the server.
 */
export default function PaperSheetAction({ context }: SlotProps) {
  const canUpload = usePermission('document:upload');
  const canReadPatients = usePermission('patient:read');
  const documents = useFeatureFlag('documents');
  const { tokenId, encounterId, status, number } = context ?? {};
  if (!canUpload || !canReadPatients || !documents || status === 'cancelled') return null;
  if (typeof tokenId === 'string') return <TokenButton tokenId={tokenId} number={number} />;
  if (typeof encounterId === 'string') return <VisitButton encounterId={encounterId} />;
  return null;
}

function TokenButton({ tokenId, number }: { tokenId: string; number: unknown }) {
  const { t } = useTranslation('clinical');
  const tenantId = useTenant()?.id;
  const userId = useSession()?.user.id;
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-paper-token={tokenId}
      aria-label={t('paper.actionLabel', { number })}
      onClick={() => {
        if (tenantId && userId) setPaperDialog({ tenantId, userId, tokenId });
      }}
    >
      {t('paper.action')}
    </Button>
  );
}

/** Only an OPD visit is kept on paper; the screen has read the visit already. */
function VisitButton({ encounterId }: { encounterId: string }) {
  const { t } = useTranslation('clinical');
  const encounter = useEncounter(encounterId);
  const [open, setOpen] = useState(false);
  if (encounter.data?.type !== 'opd') return null;
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)}>
        {t('paper.action')}
      </Button>
      <PaperDialog subject={open ? { encounterId } : null} onClose={() => setOpen(false)} />
    </>
  );
}
