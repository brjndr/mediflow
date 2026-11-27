import { useSyncExternalStore } from 'react';

/**
 * Which queue token the "Attach OPD sheet" dialog is open for (#1202). The dialog belongs to the
 * board, not to the row that opened it: a token changes list while someone is choosing a file. Ids
 * and the number only, in memory, with who asked, so another session never sees it.
 */
export interface PaperDialogRequest {
  tenantId: string;
  userId: string;
  tokenId: string;
}

let current: PaperDialogRequest | null = null;
const listeners = new Set<() => void>();

export function setPaperDialog(next: PaperDialogRequest | null): void {
  current = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const usePaperDialog = () => useSyncExternalStore(subscribe, () => current);
