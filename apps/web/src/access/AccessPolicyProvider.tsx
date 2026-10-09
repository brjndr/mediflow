import type { ReactNode } from 'react';
import type { AccessPolicy } from '@/shared/types';
import { AccessPolicyContext } from './access-policy-context';

export function AccessPolicyProvider({
  policy = null,
  children,
}: {
  policy?: AccessPolicy | null;
  children: ReactNode;
}) {
  return <AccessPolicyContext.Provider value={policy}>{children}</AccessPolicyContext.Provider>;
}
