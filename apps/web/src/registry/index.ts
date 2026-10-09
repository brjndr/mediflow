export { appRegistry } from './app-registry';
export {
  createRegistry,
  FEATURE_TITLES_NS,
  type FeatureTranslations,
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
  FeatureI18n,
  FeatureManifest,
  FeatureNav,
  FeatureRoute,
  FeatureSettings,
  LazyComponent,
  SlotContribution,
  SlotId,
  SlotProps,
  TranslationTree,
} from './types';
