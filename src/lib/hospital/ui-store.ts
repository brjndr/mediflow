import { Store } from '@tanstack/store'

export type Density = 'comfortable' | 'compact'

/**
 * App-wide UI state (TanStack Store). Server data lives in TanStack Query /
 * TanStack DB; this store only holds ephemeral client preferences.
 */
export const uiStore = new Store({
  shortcutsOpen: false,
  density: 'comfortable',
})

export const toggleShortcuts = (open?: boolean) =>
  uiStore.setState((s) => ({ ...s, shortcutsOpen: open ?? !s.shortcutsOpen }))

export const toggleDensity = () =>
  uiStore.setState((s) => ({
    ...s,
    density: s.density === 'compact' ? 'comfortable' : 'compact',
  }))
