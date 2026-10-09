import type { ReactNode } from 'react';
import type { Permission } from '@/shared/types';
import { useAllowed } from './access-policy-context';
import { ForbiddenPage } from './ForbiddenPage';

interface PermissionGuardProps {
  /** From the route's `requires` in the feature manifest. All must be held. */
  requires: readonly Permission[];
  /** From the manifest's `featureFlag`. */
  featureFlag?: string;
  children: ReactNode;
}

/**
 * Route-level access check. The route's content is never rendered when access is denied, so its
 * lazy chunk and its data requests are not triggered either.
 */
export function PermissionGuard({ requires, featureFlag, children }: PermissionGuardProps) {
  return useAllowed({ requires, featureFlag }) ? children : <ForbiddenPage />;
}
