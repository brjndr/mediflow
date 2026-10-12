import type { components } from '@mediflow/contract';

/** Someone who works at the hospital, or has been invited to. Staff, never a patient. */
export type StaffMember = components['schemas']['StaffMember'];
export type StaffPage = components['schemas']['StaffPage'];
export type StaffStatus = StaffMember['status'];
export type StaffRole = components['schemas']['StaffRole'];
export type Invite = components['schemas']['Invite'];

export interface InviteRequest {
  name: string;
  email: string;
  roleId: string;
}
