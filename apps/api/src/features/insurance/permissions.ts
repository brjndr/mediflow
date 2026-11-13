import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * The insurance rows of `docs/PRODUCT.md` (R3): the hospital admin keeps the payers and answers
 * pre-authorizations; the front desk captures a patient's policy and asks for pre-authorization.
 */
export const INSURANCE_PERMISSIONS = [
  {
    id: 'payer:read',
    description: 'See insurers, TPAs and corporates, their plans and rate agreements',
    defaults: { admin: 'all', receptionist: 'all' },
  },
  {
    id: 'payer:manage',
    description: 'Add and change insurers, TPAs, corporates, their plans and rate agreements',
    defaults: { admin: 'all' },
  },
  {
    id: 'policy:read',
    description: 'See the insurance policies on a patient’s record',
    defaults: { admin: 'all', receptionist: 'all' },
  },
  {
    id: 'policy:manage',
    description: 'Add a policy to a patient’s record and end one',
    defaults: { admin: 'all', receptionist: 'all' },
  },
  {
    id: 'preauth:read',
    description: 'See pre-authorization requests and the limit left on a visit',
    defaults: { admin: 'all', receptionist: 'all' },
  },
  {
    id: 'preauth:manage',
    description: 'Ask for pre-authorization, record the payer’s answer and withdraw a request',
    defaults: { admin: 'all', receptionist: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
