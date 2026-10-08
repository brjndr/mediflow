import { useNavigate } from '@tanstack/react-router'
import { useHotkey, useHotkeySequence } from '@tanstack/react-hotkeys'

import { toggleDensity, toggleShortcuts } from '#/lib/hospital/ui-store'

/**
 * App-wide keyboard shortcuts (TanStack Hotkeys). Single-key and sequence
 * hotkeys ignore events from inputs by default, so typing is never hijacked.
 * Page-specific shortcuts (`/` to search, `N` for new patient) live in routes.
 */
export default function GlobalHotkeys() {
  const navigate = useNavigate()

  useHotkeySequence(['G', 'D'], () => void navigate({ to: '/' }))
  useHotkeySequence(['G', 'P'], () => void navigate({ to: '/patients' }))
  useHotkeySequence(['G', 'A'], () => void navigate({ to: '/appointments' }))
  useHotkeySequence(['G', 'R'], () => void navigate({ to: '/records' }))
  useHotkeySequence(['G', 'C'], () => void navigate({ to: '/demo/ai-chat' }))

  useHotkey('Shift+/', () => toggleShortcuts())
  useHotkey('Escape', () => toggleShortcuts(false))
  useHotkey('Shift+D', () => toggleDensity())

  return null
}
