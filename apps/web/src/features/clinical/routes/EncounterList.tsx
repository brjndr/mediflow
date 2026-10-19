import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useSession } from '@/app/session';
import { useDoctorOptions } from '@/features/doctors';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters } from '@/tenancy';
import { useEncounters } from '../hooks/use-clinical';
import { ENCOUNTER_STATUSES } from '../schemas';
import type { Encounter, EncounterStatus } from '../types';

const select =
  'h-9 w-full rounded-md border bg-background px-3 text-base md:text-sm pointer-coarse:h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

/**
 * Consultations (`encounters`), for `encounter:read`: the encounters the caller may see, open
 * ones first by default, so a doctor gets back to a visit left open. Opens on the signed-in
 * doctor's own, as the queue board does; the server leaves out what is outside the caller's scope.
 */
export default function EncounterList() {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const doctorFieldId = useId();
  const statusFieldId = useId();
  const session = useSession();
  const doctors = useDoctorOptions();
  const mine = doctors.data?.find((doctor) => doctor.userId === session?.user.id);
  // Null until someone chooses: a doctor sees their own first, everyone else the whole hospital's.
  const [chosenDoctor, setChosenDoctor] = useState<string | null>(null);
  const attendingDoctorId = chosenDoctor ?? mine?.id ?? '';
  const [status, setStatus] = useState<EncounterStatus | ''>('open');
  // Until the doctors are known, it is not known whose to show first.
  const settled = !doctors.available || doctors.isSuccess || doctors.isError;
  const encounters = useEncounters({ attendingDoctorId, status }, { enabled: settled });
  const rows = useMemo(
    () => encounters.data?.pages.flatMap((page) => page.items) ?? [],
    [encounters.data],
  );
  const total = encounters.isPlaceholderData ? undefined : encounters.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<Encounter>[]>(
    () => [
      {
        id: 'patient',
        header: t('list.columns.patient'),
        value: (row) => row.patientName,
        hideable: false,
        render: (row, text) => (
          <Link
            to={`/encounters/${row.id}`}
            className="text-primary underline underline-offset-4 pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
          >
            {text}
          </Link>
        ),
      },
      { id: 'mrn', header: t('list.columns.mrn'), value: (row) => row.patientMrn, mask: maskMrn },
      {
        id: 'doctor',
        header: t('list.columns.doctor'),
        value: (row) => row.attendingDoctorName ?? '',
      },
      {
        id: 'department',
        header: t('list.columns.department'),
        value: (row) => row.departmentName ?? '',
      },
      {
        id: 'opened',
        header: t('list.columns.opened'),
        value: (row) => format.dateTime(row.openedAt),
      },
      { id: 'status', header: t('list.columns.status'), value: (row) => t(`status.${row.status}`) },
    ],
    [t, format],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('list.heading')}</h1>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:max-w-2xl">
        {doctors.available && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={doctorFieldId} className="text-sm font-medium">
              {t('list.doctor')}
            </label>
            <select
              id={doctorFieldId}
              className={select}
              value={attendingDoctorId}
              onChange={(event) => setChosenDoctor(event.target.value)}
            >
              <option value="">{t('list.allDoctors')}</option>
              {(doctors.data ?? []).map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  {doctor.id === mine?.id ? t('list.me', { name: doctor.name }) : doctor.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={statusFieldId} className="text-sm font-medium">
            {t('list.status')}
          </label>
          <select
            id={statusFieldId}
            className={select}
            value={status}
            onChange={(event) => setStatus(event.target.value as EncounterStatus | '')}
          >
            {ENCOUNTER_STATUSES.map((each) => (
              <option key={each} value={each}>
                {t(`status.${each}`)}
              </option>
            ))}
            <option value="">{t('list.allStatuses')}</option>
          </select>
        </div>
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {total === undefined ? '' : t('list.count', { count: total })}
      </p>
      <DataGrid
        label={t('list.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.patientName}
        status={
          !settled || encounters.isPending ? 'loading' : encounters.isError ? 'error' : 'ready'
        }
        errorMessage={encounters.isError ? tCommon(errorMessageKey(encounters.error)) : undefined}
        onRetry={() => void encounters.refetch()}
        emptyMessage={t('list.empty')}
        hasNextPage={encounters.hasNextPage && !encounters.isPlaceholderData}
        total={total}
        loadingMore={encounters.isFetchingNextPage}
        onLoadMore={() => void encounters.fetchNextPage()}
      />
    </div>
  );
}
