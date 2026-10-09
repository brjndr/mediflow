import type { ReactNode } from 'react';
import type { Permission } from '@/shared/types';
import { useAllowed } from './access-policy-context';

interface CanProps {
  /** One permission, or several that must all be held. */
  permission: Permission | readonly Permission[];
  /** Also require this module to be switched on for the hospital. */
  featureFlag?: string;
  /** Rendered instead when access is denied. Nothing by default. */
  fallback?: ReactNode;
  children: ReactNode;
}

/**
 * Renders its children only when the user may perform the action:
 *
 *   <Can permission="billing:refund"><RefundButton /></Can>
 *
 * This is for the experience only. The backend enforces the same check.
 */
export function Can({ permission, featureFlag, fallback = null, children }: CanProps) {
  return useAllowed({ requires: permission, featureFlag }) ? children : fallback;
}
