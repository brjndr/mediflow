import { createContext, useContext, useMemo } from 'react';
import { useAccessPolicy } from '@/access';
import type { NavItem, Registry, ResolvedContribution, SettingsSection } from './registry';
import type { SlotId } from './types';

export const RegistryContext = createContext<Registry | null>(null);

export function useRegistry(): Registry {
  const registry = useContext(RegistryContext);
  if (!registry) throw new Error('useRegistry must be used inside a RegistryProvider');
  return registry;
}

/** Navigation for the current user and hospital, in display order. */
export function useNavItems(): NavItem[] {
  const registry = useRegistry();
  const policy = useAccessPolicy();
  return useMemo(() => registry.navItems(policy), [registry, policy]);
}

/** What features contribute to one slot for the current user and hospital. */
export function useSlotContributions(slot: SlotId): ResolvedContribution[] {
  const registry = useRegistry();
  const policy = useAccessPolicy();
  return useMemo(() => registry.contributions(slot, policy), [registry, slot, policy]);
}

/** Settings sections of the enabled features the user may manage. */
export function useSettingsSections(): SettingsSection[] {
  const registry = useRegistry();
  const policy = useAccessPolicy();
  return useMemo(() => registry.settingsSections(policy), [registry, policy]);
}
