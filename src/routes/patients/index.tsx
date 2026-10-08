import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'
import {
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFn_equalsString,
  filterFn_includesString,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_text,
  tableFeatures,
  useTable,
} from '@tanstack/react-table'
import type { PaginationState, SortingState } from '@tanstack/react-table'
import { useDebouncedValue } from '@tanstack/react-pacer'
import { useHotkey } from '@tanstack/react-hotkeys'
import { useStore } from '@tanstack/react-store'
import { ArrowDown, ArrowUp, ArrowUpDown, Plus } from 'lucide-react'
import { z } from 'zod'

import PatientStatusBadge from '#/components/PatientStatusBadge'
import { Button, buttonVariants } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Select } from '#/components/ui/select'
import { hospitalKeys, patientsQuery } from '#/lib/hospital/queries'
import { PATIENT_STATUSES, fullName } from '#/lib/hospital/schemas'
import type { Patient } from '#/lib/hospital/schemas'
import { uiStore } from '#/lib/hospital/ui-store'
import { updatePatientStatus } from '#/server/hospital.functions'

const searchSchema = z.object({
  q: z.string().optional().catch(undefined),
  status: z.enum(PATIENT_STATUSES).optional().catch(undefined),
})

export const Route = createFileRoute('/patients/')({
  validateSearch: searchSchema,
  loader: ({ context }) => context.queryClient.ensureQueryData(patientsQuery()),
  component: PatientsPage,
})

// TanStack Table v9: features, columns and fallback data are module-scoped so
// row models stay stable between renders.
const features = tableFeatures({
  rowSortingFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  rowPaginationFeature,
  sortedRowModel: createSortedRowModel(),
  filteredRowModel: createFilteredRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  sortFns: { text: sortFn_text, alphanumeric: sortFn_alphanumeric },
  filterFns: {
    includesString: filterFn_includesString,
    equalsString: filterFn_equalsString,
  },
})

const helper = createColumnHelper<typeof features, Patient>()

function RowActions({ patient }: { patient: Patient }) {
  const queryClient = useQueryClient()
  const discharge = useMutation({
    mutationFn: () =>
      updatePatientStatus({ data: { id: patient.id, status: 'DISCHARGED' } }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: hospitalKeys.patients }),
        queryClient.invalidateQueries({ queryKey: hospitalKeys.stats }),
      ]),
  })

  return (
    <div className="flex justify-end gap-2">
      <Link
        to="/patients/$patientId"
        params={{ patientId: patient.id }}
        className={buttonVariants({ variant: 'outline', size: 'sm' })}
      >
        Chart
      </Link>
      {patient.status !== 'DISCHARGED' && (
        <Button
          variant="ghost"
          size="sm"
          disabled={discharge.isPending}
          onClick={() => discharge.mutate()}
        >
          Discharge
        </Button>
      )}
    </div>
  )
}

const columns = helper.columns([
  helper.accessor('mrn', { header: 'MRN', sortFn: 'alphanumeric' }),
  helper.accessor((row) => fullName(row), {
    id: 'name',
    header: 'Patient',
    sortFn: 'text',
  }),
  helper.accessor('ward', { header: 'Ward', sortFn: 'text' }),
  helper.accessor('status', {
    header: 'Status',
    filterFn: 'equalsString',
    cell: (info) => <PatientStatusBadge status={info.getValue()} />,
  }),
  helper.accessor('condition', { header: 'Condition', sortFn: 'text' }),
  helper.accessor('admittedAt', {
    header: 'Admitted',
    sortFn: 'alphanumeric',
    cell: (info) => new Date(info.getValue()).toLocaleDateString(),
  }),
  helper.display({
    id: 'actions',
    header: '',
    enableSorting: false,
    cell: (info) => <RowActions patient={info.row.original} />,
  }),
])

function PatientsPage() {
  const { data: patients } = useSuspenseQuery(patientsQuery())
  const { q = '', status } = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const density = useStore(uiStore, (s) => s.density)

  // --- search: local input -> TanStack Pacer debounce -> URL search param ---
  const searchRef = useRef<HTMLInputElement>(null)
  const [search, setSearch] = useState(q)
  const [debouncedSearch] = useDebouncedValue(search, { wait: 300 })
  useEffect(() => {
    if (debouncedSearch === q) return
    void navigate({
      search: (prev) => ({ ...prev, q: debouncedSearch || undefined }),
      replace: true,
    })
  }, [debouncedSearch, navigate, q])

  // --- hotkeys (TanStack Hotkeys) ---
  useHotkey('/', () => searchRef.current?.focus())
  useHotkey('N', () => void navigate({ to: '/patients/new' }))

  // --- table state is controlled where the URL owns it ---
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'admittedAt', desc: true },
  ])
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize: 10,
  })

  // Must be referentially stable: a new array each render would invalidate
  // the filtered row model and auto-reset the page index.
  const columnFilters = useMemo(
    () => (status ? [{ id: 'status', value: status }] : []),
    [status],
  )

  const table = useTable({
    features,
    columns,
    data: patients,
    state: {
      sorting,
      pagination,
      globalFilter: q,
      columnFilters,
    },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    globalFilterFn: 'includesString',
  })

  const rows = table.getRowModel().rows
  const filteredCount = table.getPrePaginatedRowModel().rows.length
  const cellPad = density === 'compact' ? 'px-3 py-1' : 'px-3 py-3'

  return (
    <main className="page-wrap px-4 pb-8 pt-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="island-kicker mb-1">Registry</p>
          <h1 className="display-title m-0 text-3xl font-bold text-[var(--sea-ink)]">
            Patients
          </h1>
        </div>
        <Link to="/patients/new" className={buttonVariants()}>
          <Plus /> New patient <kbd className="ml-1 text-xs opacity-80">N</kbd>
        </Link>
      </div>

      <div className="mb-4 flex flex-wrap gap-3">
        <Input
          ref={searchRef}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search name, MRN, ward, condition…   ( / )"
          aria-label="Search patients"
          className="max-w-sm"
        />
        <Select
          aria-label="Filter by status"
          className="w-44"
          value={status ?? ''}
          onChange={(e) =>
            void navigate({
              search: (prev) => ({
                ...prev,
                status: (e.target.value || undefined) as typeof status,
              }),
            })
          }
        >
          <option value="">All statuses</option>
          {PATIENT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </div>

      <div className="island-shell overflow-x-auto rounded-2xl">
        <table className="w-full border-collapse text-left text-sm">
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id} className="border-b border-[var(--line)]">
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted()
                  return (
                    <th
                      key={header.id}
                      className={`${cellPad} font-semibold text-[var(--sea-ink-soft)]`}
                      aria-sort={
                        sorted === 'asc'
                          ? 'ascending'
                          : sorted === 'desc'
                            ? 'descending'
                            : 'none'
                      }
                    >
                      {header.isPlaceholder ? null : header.column.getCanSort() ? (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 font-semibold"
                          onClick={header.column.getToggleSortingHandler()}
                        >
                          <table.FlexRender header={header} />
                          {sorted === 'asc' ? (
                            <ArrowUp size={14} />
                          ) : sorted === 'desc' ? (
                            <ArrowDown size={14} />
                          ) : (
                            <ArrowUpDown size={14} className="opacity-40" />
                          )}
                        </button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.id}
                className="border-b border-[var(--line)] last:border-0 hover:bg-[var(--link-bg-hover)]"
              >
                {row.getAllCells().map((cell) => (
                  <td
                    key={cell.id}
                    className={`${cellPad} text-[var(--sea-ink)]`}
                  >
                    <table.FlexRender cell={cell} />
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td
                  colSpan={columns.length}
                  className="p-8 text-center text-[var(--sea-ink-soft)]"
                >
                  No patients match your filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm text-[var(--sea-ink-soft)]">
        <span>
          {filteredCount} of {patients.length} patients · page{' '}
          {pagination.pageIndex + 1} of {Math.max(table.getPageCount(), 1)}
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            Next
          </Button>
        </div>
      </div>
    </main>
  )
}
