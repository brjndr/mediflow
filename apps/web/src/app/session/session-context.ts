import { createContext, useContext } from 'react';
import type { Session } from './types';

/** Provided only once GET /session has resolved. Null means nobody is signed in. */
export const SessionContext = createContext<Session | null>(null);

export function useSession(): Session | null {
  return useContext(SessionContext);
}
