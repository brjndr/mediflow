import { useStore } from '@tanstack/react-store'

import { Button } from '#/components/ui/button'
import { SHORTCUTS } from '#/lib/hospital/shortcuts'
import { toggleShortcuts, uiStore } from '#/lib/hospital/ui-store'

export default function ShortcutsDialog() {
  const open = useStore(uiStore, (s) => s.shortcutsOpen)
  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4"
      onClick={() => toggleShortcuts(false)}
    >
      <div
        className="island-shell w-full max-w-lg rounded-2xl bg-[var(--surface-strong)] p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="m-0 text-lg font-bold text-[var(--sea-ink)]">
            Keyboard shortcuts
          </h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => toggleShortcuts(false)}
          >
            Close
          </Button>
        </div>
        <ul className="m-0 grid list-none gap-2 p-0">
          {SHORTCUTS.map((s) => (
            <li
              key={s.keys + s.label}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span className="text-[var(--sea-ink)]">
                {s.label}
                <span className="ml-2 text-xs text-[var(--sea-ink-soft)]">
                  {s.scope}
                </span>
              </span>
              <kbd className="rounded-md border border-[var(--line)] bg-[var(--chip-bg)] px-2 py-0.5 font-mono text-xs">
                {s.keys}
              </kbd>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
