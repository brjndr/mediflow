/** First element of every key that holds tenant data. */
export const TENANT_SCOPE = 'tenant';

/** Prefix shared by everything cached for one hospital: `['tenant', tenantId]`. */
export function tenantScope(tenantId: string) {
  return [TENANT_SCOPE, tenantId] as const;
}

/**
 * Query key factory for one resource. Every key starts with the tenant id, so data cached for one
 * hospital can never be read under another. Build all keys through a factory, never by hand.
 *
 *   export const patientKeys = createTenantKeys('patients');
 *   useQuery({ queryKey: patientKeys.list(tenantId, filters), ... })
 *   queryClient.invalidateQueries({ queryKey: patientKeys.lists(tenantId) })
 */
export function createTenantKeys<Resource extends string>(resource: Resource) {
  const all = (tenantId: string) => [...tenantScope(tenantId), resource] as const;
  return {
    /** Everything for this resource in one hospital. */
    all,
    lists: (tenantId: string) => [...all(tenantId), 'list'] as const,
    list: <Filters>(tenantId: string, filters: Filters) =>
      [...all(tenantId), 'list', filters] as const,
    details: (tenantId: string) => [...all(tenantId), 'detail'] as const,
    detail: (tenantId: string, id: string) => [...all(tenantId), 'detail', id] as const,
  };
}
