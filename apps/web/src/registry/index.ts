export { appRegistry } from './app-registry';
export {
  createRegistry,
  type NavItem,
  type RegisteredRoute,
  type Registry,
  type ResolvedContribution,
  type SettingsSection,
} from './registry';
export {
  useNavItems,
  useRegistry,
  useSettingsSections,
  useSlotContributions,
} from './registry-context';
export { RegistryProvider } from './RegistryProvider';
export { Slot } from './Slot';
export type {
  DashboardWidget,
  FeatureManifest,
  FeatureNav,
  FeatureRoute,
  FeatureSettings,
  LazyComponent,
  SlotContribution,
  SlotId,
  SlotProps,
} from './types';
