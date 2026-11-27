import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '@/shared/ui/dialog';
import type { PaperSubject } from '../api';
import { PaperSheetPanel } from './PaperSheetPanel';

/** The dialog of a paper visit, open while there is a subject. It stays open while it saves. */
export function PaperDialog({
  subject,
  onClose,
}: {
  subject: PaperSubject | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('clinical');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={subject !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('paper.title')}
      closeLabel={t('paper.close')}
      busy={busy}
    >
      {subject && <PaperSheetPanel subject={subject} onBusy={setBusy} />}
    </Dialog>
  );
}
