import { matchPath } from 'react-router';
import { isAllowed, useAccessPolicy } from '@/access';
import { useRegistry } from '@/registry';

/**
 * Where a record named in the log opens, for the entity kinds a feature makes linkable (`links`
 * in its manifest), or null: then the id stays text. The address is the manifest's own and holds
 * only the record id, never a hospital or anything about the record. A link is offered only when
 * the caller's policy lets them open that route, so a click never lands on "no access".
 */
export function useRecordLink(): (entity: string, entityId: string | null) => string | null {
  const registry = useRegistry();
  const policy = useAccessPolicy();
  return (entity, entityId) => {
    if (!entityId) return null;
    const path = registry.linkPath(entity, entityId);
    if (path === null) return null;
    const route = registry.routes.find((candidate) =>
      matchPath({ path: `/${candidate.path}`, end: true }, `/${path}`),
    );
    if (!route) return null;
    return isAllowed(policy, { requires: route.requires, featureFlag: route.featureFlag })
      ? `/${path}`
      : null;
  };
}
