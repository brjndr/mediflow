import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFeatureFlag, usePermission } from '@/access';
import type { SlotProps } from '@/registry';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import type { PaperSubject } from '../api';
import { useEncounter } from '../hooks/use-clinical';
import { PaperSheetPanel } from './PaperSheetPanel';

/**
 * "Attach OPD sheet" (#1202) on a queue token (`queue.row.actions`) and on a visit
 * (`encounter.detail.actions`), for `encounter:recordPaper`, given ids and values only. A row of
 * the queue reads nothing until it is pressed. Attaching also needs `document:upload`,
 * `patient:read` and the documents module, as on the server.
 */
export default function PaperSheetAction({ context }: SlotProps) {
  const canUpload = usePermission('document:upload');
  const canReadPatients = usePermission('patient:read');
  const documents = useFeatureFlag('documents');
  const { tokenId, encounterId, status, number } = context ?? {};
  if (!canUpload || !canReadPatients || !documents || status === 'cancelled') return null;
  if (typeof tokenId === 'string') {
    return <PaperSheetButton subject={{ tokenId }} number={number} />;
  }
  if (typeof encounterId === 'string') return <VisitButton encounterId={encounterId} />;
  return null;
}

/** Only an OPD visit is kept on paper; the screen has read the visit already. */
function VisitButton({ encounterId }: { encounterId: string }) {
  const encounter = useEncounter(encounterId);
  if (encounter.data?.type !== 'opd') return null;
  return <PaperSheetButton subject={{ encounterId }} />;
}

function PaperSheetButton({ subject, number }: { subject: PaperSubject; number?: unknown }) {
  const { t } = useTranslation('clinical');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const row = 'tokenId' in subject;
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size={row ? 'sm' : 'default'}
        aria-label={row ? t('paper.actionLabel', { number }) : undefined}
        onClick={() => setOpen(true)}
      >
        {t('paper.action')}
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t('paper.title')}
        closeLabel={t('paper.close')}
        busy={busy}
      >
        <PaperSheetPanel subject={subject} onBusy={setBusy} />
      </Dialog>
    </>
  );
}
