import type { components, paths } from '@mediflow/contract';

/** A hospital as the platform sees it: its configuration and head count, never its data. */
export type Hospital = components['schemas']['PlatformHospital'];
export type HospitalPage = components['schemas']['PlatformHospitalPage'];
export type HospitalCreate = NonNullable<
  paths['/platform/hospitals']['post']['requestBody']
>['content']['application/json'];
export type HospitalStatus = Hospital['status'];

/** The limits an edit may change, with the version it started from. */
export interface HospitalLimitsUpdate {
  version: number;
  maxUsers?: number | null;
  storageMb?: number | null;
}

/** An invite to a hospital's first admin that nobody has accepted or withdrawn. */
export type HospitalInvite = components['schemas']['PlatformInvite'];
export type HospitalInvitePage = components['schemas']['PlatformInvitePage'];
