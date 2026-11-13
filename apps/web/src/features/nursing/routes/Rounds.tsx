import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useSession } from '@/app/session';
import { useDoctorOptions } from '@/features/doctors';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters } from '@/tenancy';
import { useStays } from '../hooks/use-nursing';
import type { StayRow } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';
/** The address value that stands for every doctor. */
const ALL = 'all';

/**
 * A doctor's round list (#159): the patients now admitted under a doctor, in the order of their
 * admission. It opens on the signed-in doctor's own patients; the choice is in the address. A
 * doctor whose scope is `own` is held to their own patients by the server whatever is asked.
 */
// Default export: route modules are loaded by the manifest with a dynamic import.
export default function Rounds() {
  const { t } = useTranslation('nursing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const navigate = useNavigate();
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const doctors = useDoctorOptions();
  const own = doctors.data?.find((doctor) => doctor.userId === session?.user.id);
  const chosen = params.get('doctor');
  // Wait for the doctors before the first read, so the list does not flash everybody's patients.
  const waiting = doctors.available && doctors.isPending && chosen === null;
  const doctorId = chosen === null ? (own?.id ?? '') : chosen === ALL ? '' : chosen;
  const stays = useStays('', doctorId, !waiting);
  const rows = useMemo(() => stays.data?.pages.flatMap((page) => page.items) ?? [], [stays.data]);
  const total = stays.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<StayRow>[]>(
    () => [
      {
        id: 'patient',
        header: t('columns.patient'),
        value: (row) => row.patientName,
        hideable: false,
      },
      { id: 'mrn', header: t('columns.mrn'), value: (row) => row.patientMrn, mask: maskMrn },
      {
        id: 'bed',
        header: t('columns.bed'),
        value: (row) => (row.bed ? `${row.bed.bedNumber} ${row.bed.wardName}`.trim() : t('noBed')),
      },
      { id: 'doctor', header: t('columns.doctor'), value: (row) => row.doctorName },
      {
        id: 'admittedAt',
        header: t('columns.admittedAt'),
        value: (row) => format.dateTime(row.admittedAt),
      },
    ],
    [t, format],
  );

  const actions: GridAction<StayRow>[] = [
    {
      id: 'notes',
      label: t('actions.notes'),
      requires: 'progressNote:read',
      onSelect: (row) => navigate(`/nursing/${row.id}/notes`),
    },
    {
      id: 'vitals',
      label: t('actions.vitals'),
      requires: 'nursingVitals:read',
      onSelect: (row) => navigate(`/nursing/${row.id}/vitals`),
    },
    {
      id: 'mar',
      label: t('actions.mar'),
      requires: 'mar:read',
      onSelect: (row) => navigate(`/nursing/${row.id}/mar`),
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <Link to="/nursing" className="text-sm underline underline-offset-2">
          {t('back')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{t('rounds.heading')}</h1>
        <p className="text-muted-foreground">{t('rounds.description')}</p>
      </div>

      {doctors.available && doctors.data && (
        <label className="flex min-w-52 flex-col gap-1 text-sm font-medium">
          {t('rounds.doctor')}
          <select
            value={chosen === null ? (own?.id ?? ALL) : chosen}
            onChange={(event) => setParams({ doctor: event.target.value })}
            className={`${control} max-w-xs`}
          >
            <option value={ALL}>{t('rounds.allDoctors')}</option>
            {doctors.data.map((doctor) => (
              <option key={doctor.id} value={doctor.id}>
                {doctor.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <p className="text-sm text-muted-foreground">
        {total === undefined || stays.isPlaceholderData ? '' : t('count', { count: total })}
      </p>
      <DataGrid
        label={t('rounds.gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => t('rowLabel', { patient: row.patientName })}
        actions={stays.isPlaceholderData ? [] : actions}
        status={stays.isPending || waiting ? 'loading' : stays.isError ? 'error' : 'ready'}
        errorMessage={stays.isError ? tCommon(errorMessageKey(stays.error)) : undefined}
        onRetry={() => void stays.refetch()}
        emptyMessage={t('rounds.empty')}
        hasNextPage={stays.hasNextPage && !stays.isPlaceholderData}
        total={stays.isPlaceholderData ? undefined : total}
        loadingMore={stays.isFetchingNextPage}
        onLoadMore={() => void stays.fetchNextPage()}
      />
    </div>
  );
}
