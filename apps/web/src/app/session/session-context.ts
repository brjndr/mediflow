import { createContext, useContext } from 'react';
import type { User } from '@/shared/types';

/** Placeholder until F-03 loads the session from GET /session. Null means no signed-in user. */
export const SessionContext = createContext<User | null>(null);

export function useSession(): User | null {
  return useContext(SessionContext);
}
