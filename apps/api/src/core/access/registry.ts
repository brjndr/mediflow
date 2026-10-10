/** Permissions are `resource:action`. A dotted resource names a field: `patient.diagnosis:read`. */
export type Permission = `${string}:${string}`;
export type PermissionScope = 'all' | 'own' | 'department';

/** The roles every hospital starts with. `platform_admin` is not one: it belongs to no hospital. */
export const BUILT_IN_ROLES = [
  'admin',
  'doctor',
  'nurse',
  'receptionist',
  'pharmacist',
  'lab_technician',
  'radiologist',
  'store_keeper',
] as const;
export type BuiltInRole = (typeof BUILT_IN_ROLES)[number];

export interface PermissionDefinition {
  id: Permission;
  /** What holding it allows, for the role management screen. */
  description: string;
  /**
   * Which built-in roles get it when a hospital is created, and with what scope. Seed data
   * only: each hospital's admin changes its roles afterwards, and the live policy is what
   * counts.
   */
  defaults?: Partial<Record<BuiltInRole, PermissionScope>>;
}

const PERMISSION_ID = /^[a-z][A-Za-z0-9_.]*:[a-z][A-Za-z0-9_]*$/;

export class PermissionRegistryError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid permission declarations:\n- ${problems.join('\n- ')}`);
    this.name = 'PermissionRegistryError';
  }
}

export interface PermissionRegistry {
  /** Called by each feature's plugin with the contents of its permissions.ts. */
  register(feature: string, definitions: readonly PermissionDefinition[]): void;
  has(permission: string): boolean;
  all(): (PermissionDefinition & { feature: string })[];
}

/**
 * Every permission the API knows, declared by the feature that owns it. A permission that is
 * not here cannot be required by a route, so a typo in a route fails at startup instead of
 * silently denying (or, worse, guarding nothing).
 */
export function createPermissionRegistry(): PermissionRegistry {
  const definitions = new Map<string, PermissionDefinition & { feature: string }>();

  return {
    register(feature, declared) {
      const problems: string[] = [];
      const seen = new Set<string>();
      for (const definition of declared) {
        const owner = definitions.get(definition.id)?.feature;
        if (!PERMISSION_ID.test(definition.id)) {
          problems.push(`${feature}: "${definition.id}" is not resource:action`);
        } else if (owner !== undefined || seen.has(definition.id)) {
          problems.push(
            `${feature}: "${definition.id}" is already declared by ${owner ?? feature}`,
          );
        }
        seen.add(definition.id);
        for (const role of Object.keys(definition.defaults ?? {})) {
          if (!(BUILT_IN_ROLES as readonly string[]).includes(role)) {
            problems.push(`${feature}: "${definition.id}" has a default for unknown role ${role}`);
          }
        }
      }
      if (problems.length > 0) throw new PermissionRegistryError(problems);
      for (const definition of declared) definitions.set(definition.id, { ...definition, feature });
    },
    has: (permission) => definitions.has(permission),
    all: () => [...definitions.values()],
  };
}
