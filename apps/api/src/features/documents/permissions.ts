import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * Patient documents (#194). Whoever sees a patient's record sees its documents, clinicians and the
 * front desk add them; retiring one and setting how long a category is kept are the admin's, as
 * is merging two records (`patient:merge`, in the patients feature).
 */
export const DOCUMENT_PERMISSIONS = [
  {
    id: 'document:read',
    description: 'See the documents kept on a patient’s record and download them',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', receptionist: 'all' },
  },
  {
    id: 'document:upload',
    description: 'Attach a document (a consent form, an outside report, an ID proof) to a patient',
    defaults: { admin: 'all', doctor: 'all', nurse: 'all', receptionist: 'all' },
  },
  {
    id: 'document:retire',
    description: 'Retire a document that was attached by mistake or is replaced, with a reason',
    defaults: { admin: 'all' },
  },
  {
    id: 'documentRetention:read',
    description: 'See how long the hospital keeps the documents of each category',
    defaults: { admin: 'all' },
  },
  {
    id: 'documentRetention:manage',
    description: 'Set how long the hospital keeps the documents of each category',
    defaults: { admin: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
