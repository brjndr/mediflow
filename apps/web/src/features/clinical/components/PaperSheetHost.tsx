import { useCallback, useEffect } from 'react';
import { useSession } from '@/app/session';
import { focusIfLost } from '@/shared/lib/focus';
import { useTenant } from '@/tenancy';
import { PaperDialog } from './PaperDialog';
import { setPaperDialog, usePaperDialog } from './paper-dialog-store';

/**
 * The "Attach OPD sheet" dialog of the queue board (`queue.board.dialogs`, #1202), above its
 * lists. Leaving the board, signing out or switching hospital forgets what it was open for.
 */
export default function PaperSheetHost() {
  const request = usePaperDialog();
  const tenantId = useTenant()?.id;
  const userId = useSession()?.user.id;
  const mine = request && request.tenantId === tenantId && request.userId === userId;
  useEffect(() => () => setPaperDialog(null), [tenantId, userId]);
  const tokenId = mine ? request.tokenId : undefined;
  const close = useCallback(() => {
    const button = `[data-paper-token="${tokenId}"]`;
    setPaperDialog(null);
    // The row that opened it may have moved: after the dialog has given focus back, if it could.
    setTimeout(() => {
      focusIfLost(
        document.querySelector<HTMLElement>(button) ?? document.querySelector<HTMLElement>('main'),
      );
    });
  }, [tokenId]);
  return <PaperDialog subject={tokenId ? { tokenId } : null} onClose={close} />;
}
