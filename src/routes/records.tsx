import { useMemo, useRef, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useDebouncedValue } from '@tanstack/react-pacer'
import { useHotkey } from '@tanstack/react-hotkeys'

import { Badge } from '#/components/ui/badge'
import { Input } from '#/components/ui/input'
import { generateLabRecords } from '#/lib/hospital/lab-records'

export const Route = createFileRoute('/records')({
  component: RecordsPage,
})

// Fixed reference time keeps SSR and client output identical.
const RECORDS = generateLabRecords(25_000, Date.UTC(2026, 4, 8))
const ROW_HEIGHT = 48

function RecordsPage() {
  const searchRef = useRef<HTMLInputElement>(null)
  const parentRef = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState('')
  const [abnormalOnly, setAbnormalOnly] = useState(false)
  const [debounced] = useDebouncedValue(search, { wait: 200 })

  useHotkey('/', () => searchRef.current?.focus())

  const rows = useMemo(() => {
    const q = debounced.trim().toLowerCase()
    return RECORDS.filter(
      (r) =>
        (!abnormalOnly || r.abnormal) &&
        (!q ||
          r.patient.toLowerCase().includes(q) ||
          r.test.toLowerCase().includes(q)),
    )
  }, [debounced, abnormalOnly])

  // Only the visible window (plus overscan) is ever mounted in the DOM.
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  })
  const items = virtualizer.getVirtualItems()

  return (
    <main className="page-wrap px-4 pb-8 pt-10">
      <p className="island-kicker mb-1">Laboratory · TanStack Virtual</p>
      <h1 className="display-title mb-2 text-3xl font-bold text-[var(--sea-ink)]">
        Lab records
      </h1>
      <p className="mb-5 text-sm text-[var(--sea-ink-soft)]">
        {rows.length.toLocaleString()} results — only {items.length} rows are
        rendered at any moment.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <Input
          ref={searchRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search patient or test…   ( / )"
          aria-label="Search lab records"
          className="max-w-sm"
        />
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={abnormalOnly}
            onChange={(e) => setAbnormalOnly(e.target.checked)}
          />
          Abnormal only
        </label>
      </div>

      <div className="island-shell rounded-2xl">
        <div
          role="row"
          className="grid grid-cols-[1.4fr_1.4fr_1fr_1fr_8rem] gap-3 border-b border-[var(--line)] px-4 py-2 text-xs font-semibold uppercase tracking-wide text-[var(--sea-ink-soft)]"
        >
          <span>Patient</span>
          <span>Test</span>
          <span>Result</span>
          <span>Reference</span>
          <span>Collected</span>
        </div>
        <div
          ref={parentRef}
          className="h-[60vh] overflow-auto"
          role="table"
          aria-rowcount={rows.length}
        >
          <div
            style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
          >
            {items.map((item) => {
              const r = rows[item.index]
              return (
                <div
                  key={r.id}
                  role="row"
                  className="absolute left-0 top-0 grid w-full grid-cols-[1.4fr_1.4fr_1fr_1fr_8rem] items-center gap-3 border-b border-[var(--line)] px-4 text-sm"
                  style={{
                    height: item.size,
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <span className="truncate">{r.patient}</span>
                  <span className="truncate">{r.test}</span>
                  <span className="flex items-center gap-2">
                    {r.value} {r.unit}
                    {r.abnormal && <Badge tone="danger">Abnormal</Badge>}
                  </span>
                  <span className="text-[var(--sea-ink-soft)]">
                    {r.low}–{r.high}
                  </span>
                  <span className="text-[var(--sea-ink-soft)]">
                    {new Date(r.at).toISOString().slice(0, 10)}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </main>
  )
}
