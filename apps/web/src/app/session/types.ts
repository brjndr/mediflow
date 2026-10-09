import type { AccessPolicy, Tenant, User } from '@/shared/types';

/** What GET /session returns for a signed-in user. */
export interface Session {
  user: User;
  /** Null until a user with several hospitals picks one (F-05). */
  activeTenant: Tenant | null;
  /** Null when there is no active tenant. */
  policy: AccessPolicy | null;
}
