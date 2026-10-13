import type { PermissionDefinition } from '../../core/access/registry.js';

/**
 * Templates are the hospital's own blank forms: those who write a prescription, a note, a consent
 * form or a discharge summary read them, and the hospital's admin keeps them. Removing what
 * should never have been typed into one is a permission of its own, because it is the one thing
 * that changes a saved version.
 */
export const TEMPLATE_PERMISSIONS = [
  {
    id: 'template:read',
    description: 'See the document templates of the hospital, and every version of each',
    defaults: { admin: 'all', doctor: 'all' },
  },
  {
    id: 'template:manage',
    description: 'Add a template, save a new version of one, archive and restore it',
    defaults: { admin: 'all' },
  },
  {
    id: 'template:redact',
    description:
      'Remove the name and the text of an older version of a template, when something was typed into it that should not be kept',
    defaults: { admin: 'all' },
  },
] as const satisfies readonly PermissionDefinition[];
