import type { components, paths } from '@mediflow/contract';

/** A hospital as the platform sees it: its configuration and head count, never its data. */
export type Hospital = components['schemas']['PlatformHospital'];
export type HospitalPage = components['schemas']['PlatformHospitalPage'];
export type HospitalCreate = NonNullable<
  paths['/platform/hospitals']['post']['requestBody']
>['content']['application/json'];
export type HospitalStatus = Hospital['status'];
