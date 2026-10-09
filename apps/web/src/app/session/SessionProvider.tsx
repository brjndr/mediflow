import type { ReactNode } from 'react';
import type { User } from '@/shared/types';
import { SessionContext } from './session-context';

export function SessionProvider({
  user = null,
  children,
}: {
  user?: User | null;
  children: ReactNode;
}) {
  return <SessionContext.Provider value={user}>{children}</SessionContext.Provider>;
}
