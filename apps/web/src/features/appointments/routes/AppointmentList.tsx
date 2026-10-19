import { differenceInCalendarDays } from 'date-fns';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Can } from '@/access';
import { useSession } from '@/app/session';
import { useDoctorOptions } from '@/features/doctors';
import { Slot } from '@/registry';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { maskMrn } from '@/shared/utils/mask';
import { todayIn, type DayString } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import { STATUS_STYLE } from '../components/status';
import { ViewSwitch } from '../components/ViewSwitch';
import { useAppointments } from '../hooks/use-appointments';
import { APPOINTMENT_STATUSES, MAX_RANGE_DAYS } from '../schemas';
import type { AppointmentStatus, AppointmentSummary } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';
const field = 'flex min-w-40 flex-col gap-1 text-sm font-medium';

/** Why a range of days cannot be asked for, as a key of this feature's strings. */
function rangeProblem(from: DayString, to: DayString): string | null {
  if (from === '' || to === '') return 'filters.rangeMissing';
  const days = differenceInCalendarDays(new Date(`${to}T12:00:00Z`), new Date(`${from}T12:00:00Z`));
  if (days < 0) return 'filters.rangeBackwards';
  if (days >= MAX_RANGE_DAYS) return 'filters.rangeTooLong';
  return null;
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function AppointmentList() {
  const { t } = useTranslation('appointments');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const navigate = useNavigate();
  const tenant = useTenant();
  const session = useSession();
  const today = todayIn(tenant?.timezone ?? 'UTC');

  const [from, setFrom] = useState<DayString>(today);
  const [to, setTo] = useState<DayString>(today);
  const [status, setStatus] = useState<AppointmentStatus | ''>('');
  // Null until someone chooses: then a doctor sees their own schedule, everyone else every
  // doctor's. Choosing "every doctor" is a choice, and is kept.
  const [chosenDoctor, setChosenDoctor] = useState<string | null>(null);

  const doctors = useDoctorOptions();
  const mine = doctors.data?.find((doctor) => doctor.userId === session?.user.id);
  const doctorId = chosenDoctor ?? mine?.id ?? '';
  // Until the doctors are known, it is not known whose schedule to show first.
  const doctorsSettled = !doctors.available || doctors.isSuccess || doctors.isError;

  const problem = rangeProblem(from, to);
  const appointments = useAppointments(
    { from, to, doctorId, status },
    problem === null && doctorsSettled,
  );

  const rows = useMemo(
    () => appointments.data?.pages.flatMap((page) => page.items) ?? [],
    [appointments.data],
  );
  const total = appointments.data?.pages[0]?.total;
  const oneDay = from === to;

  const columns = useMemo<GridColumn<AppointmentSummary>[]>(
    () => [
      {
        id: 'patient',
        header: t('columns.patient'),
        value: (row) => row.patientName,
        hideable: false,
        render: (row, text) => (
          <span className="flex flex-col items-start gap-1">
            {text}
            {/* Other features' actions for the appointment (the queue's "Check in"), given ids
                and values only. Rendered for every row: a contribution reads no data of its own. */}
            <Slot
              id="appointment.row.actions"
              context={{ appointmentId: row.id, status: row.status, startsAt: row.startsAt }}
            />
          </span>
        ),
      },
      {
        id: 'time',
        header: t('columns.time'),
        value: (row) =>
          t('timeRange', {
            start: oneDay ? format.time(row.startsAt) : format.dateTime(row.startsAt),
            end: format.time(row.endsAt),
          }),
      },
      { id: 'mrn', header: t('columns.mrn'), value: (row) => row.patientMrn, mask: maskMrn },
      { id: 'doctor', header: t('columns.doctor'), value: (row) => row.doctorName },
      {
        id: 'department',
        header: t('columns.department'),
        value: (row) => row.departmentName ?? '',
      },
      {
        id: 'status',
        header: t('columns.status'),
        value: (row) => t(`status.${row.status}`),
        // It holds other features' badges too: hiding it would hide theirs.
        hideable: false,
        render: (row, text) => (
          <span className="inline-flex flex-wrap items-center gap-1">
            <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[row.status]}`}>
              {text}
            </span>
            {/* Other features' badges for the appointment, given its id and nothing else. */}
            <Slot id="appointment.row.badges" context={{ appointmentId: row.id }} />
          </span>
        ),
      },
    ],
    [t, format, oneDay],
  );

  const actions = useMemo<GridAction<AppointmentSummary>[]>(
    () => [
      {
        id: 'open',
        label: t('actions.open'),
        onSelect: (row) => navigate(`/appointments/${row.id}`),
      },
      {
        id: 'open-patient',
        label: t('actions.openPatient'),
        requires: 'patient:read',
        featureFlag: 'patients',
        // The patient's id only: never a name in an address.
        onSelect: (row) => navigate(`/patients/${row.patientId}`),
      },
    ],
    [t, navigate],
  );

  const filtered = doctorId !== '' || status !== '';

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
          <p className="text-muted-foreground">{t('description')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ViewSwitch />
          <Can permission="appointment:create">
            <Button asChild>
              <Link to="/appointments/new">{t('book.open')}</Link>
            </Button>
          </Can>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className={field}>
          {t('filters.from')}
          <input
            type="date"
            value={from}
            onChange={(event) => setFrom(event.target.value)}
            className={control}
          />
        </label>
        <label className={field}>
          {t('filters.to')}
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(event) => setTo(event.target.value)}
            className={control}
          />
        </label>
        {doctors.available && (
          <label className={`${field} min-w-52`}>
            {t('filters.doctor')}
            <select
              value={doctorId}
              onChange={(event) => setChosenDoctor(event.target.value)}
              className={control}
            >
              <option value="">{t('filters.allDoctors')}</option>
              {(doctors.data ?? []).map((doctor) => (
                <option key={doctor.id} value={doctor.id}>
                  {doctor.id === mine?.id ? t('filters.me', { name: doctor.name }) : doctor.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={field}>
          {t('filters.status')}
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as AppointmentStatus | '')}
            className={control}
          >
            <option value="">{t('filters.allStatuses')}</option>
            {APPOINTMENT_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`status.${value}`)}
              </option>
            ))}
          </select>
        </label>
        {from !== today || to !== today ? (
          <button
            type="button"
            onClick={() => {
              setFrom(today);
              setTo(today);
            }}
            className="h-9 rounded-md border px-3 text-sm font-medium hover:bg-muted pointer-coarse:h-11"
          >
            {t('filters.today')}
          </button>
        ) : null}
      </div>

      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {t(problem, { count: MAX_RANGE_DAYS })}
        </p>
      ) : (
        <>
          <p role="status" className="text-sm text-muted-foreground">
            {/* Not while the previous filter's rows are still shown: the total would be theirs. */}
            {total === undefined || appointments.isPlaceholderData
              ? ''
              : t('count', { count: total })}
          </p>
          <DataGrid
            label={t('gridLabel')}
            columns={columns}
            rows={rows}
            rowId={(row) => row.id}
            rowLabel={(row) => row.patientName}
            actions={actions}
            status={appointments.isPending ? 'loading' : appointments.isError ? 'error' : 'ready'}
            errorMessage={
              appointments.isError ? tCommon(errorMessageKey(appointments.error)) : undefined
            }
            onRetry={() => void appointments.refetch()}
            emptyMessage={filtered ? t('emptyFiltered') : t(oneDay ? 'emptyDay' : 'empty')}
            // Not the next page of the previous filter's rows, while those are still shown.
            hasNextPage={appointments.hasNextPage && !appointments.isPlaceholderData}
            total={appointments.isPlaceholderData ? undefined : total}
            loadingMore={appointments.isFetchingNextPage}
            onLoadMore={() => void appointments.fetchNextPage()}
          />
        </>
      )}
    </div>
  );
}
