export { AccessPolicyProvider } from './AccessPolicyProvider';
export {
  useAccessPolicy,
  useAllowed,
  useFeatureFlag,
  usePermission,
  usePermissionScope,
} from './access-policy-context';
export { Can } from './Can';
export { ForbiddenPage } from './ForbiddenPage';
export { PermissionGuard } from './PermissionGuard';
export {
  hasPermission,
  isAllowed,
  isFeatureEnabled,
  permissionScope,
  type AccessRequirement,
} from './policy';
export { POLICY_REFRESH_INTERVAL_MS, usePolicyRefresh } from './use-policy-refresh';
