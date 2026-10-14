import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Can, useAllowed } from '@/access';
import { useSession } from '@/app/session';
import { useDoctorOptions } from '@/features/doctors';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { useIsDesktop } from '@/shared/hooks/use-is-desktop';
import { Calendar, type CalendarEventItem, type CalendarView } from '@/shared/ui/calendar';
import { addDays, visibleDays, weekStartFor } from '@/shared/ui/calendar/zoned';
import { todayIn, type DayString } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import { ViewSwitch } from '../components/ViewSwitch';
import {
  CALENDAR_MAX_APPOINTMENTS,
  useCalendarAppointments,
} from '../hooks/use-calendar-appointments';
import type { AppointmentStatus } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';
const field = 'flex min-w-40 flex-col gap-1 text-sm font-medium';
const iconButton =
  'inline-flex size-9 items-center justify-center rounded-md border hover:bg-muted pointer-coarse:size-11';

const STATUS_TONE: Record<AppointmentStatus, CalendarEventItem['tone']> = {
  scheduled: 'primary',
  completed: 'muted',
  cancelled: 'struck',
  no_show: 'danger',
};

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function AppointmentCalendar() {
  const { t } = useTranslation('appointments');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const navigate = useNavigate();
  const tenant = useTenant();
  const session = useSession();
  const timezone = tenant?.timezone ?? 'UTC';
  const locale = tenant?.locale ?? 'en';
  const today = todayIn(timezone);

  // The week is for desktop width (CLAUDE.md, Responsive Design): narrower, the day is shown.
  const isDesktop = useIsDesktop();
  const [chosenView, setChosenView] = useState<CalendarView>('week');
  const view: CalendarView = isDesktop ? chosenView : 'day';
  const [day, setDay] = useState<DayString>(today);
  // Null until someone chooses: a doctor opens on their own calendar, everyone else on the first
  // doctor's. The calendar is always one doctor's.
  const [chosenDoctor, setChosenDoctor] = useState<string | null>(null);

  const doctors = useDoctorOptions();
  const mine = doctors.data?.find((doctor) => doctor.userId === session?.user.id);
  const doctorId = chosenDoctor ?? mine?.id ?? doctors.data?.[0]?.id ?? '';

  const { from, to } = visibleDays(view, day, weekStartFor(locale));
  const appointments = useCalendarAppointments({ from, to, doctorId }, doctors.available);

  const canOpenPatient = useAllowed({ requires: 'patient:read', featureFlag: 'patients' });
  const items = appointments.data?.items;
  const events = useMemo<CalendarEventItem[]>(
    () =>
      (items ?? []).map((item) => ({
        id: item.id,
        // Not by colour alone: a status other than scheduled is also said in words.
        title:
          item.status === 'scheduled'
            ? item.patientName
            : t('calendar.eventWithStatus', {
                name: item.patientName,
                status: t(`status.${item.status}`),
              }),
        start: item.startsAt,
        end: item.endsAt,
        tone: STATUS_TONE[item.status],
        hint: t(`status.${item.status}`),
      })),
    [items, t],
  );

  const openPatient = (id: string) => {
    const item = items?.find((candidate) => candidate.id === id);
    // The patient's id only: never a name in an address.
    if (item) navigate(`/patients/${item.patientId}`);
  };

  const step = view === 'day' ? 1 : 7;
  const heading =
    view === 'day'
      ? format.calendarDate(day)
      : t('calendar.weekRange', {
          start: format.calendarDate(from),
          end: format.calendarDate(to),
        });

  const header = (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('calendar.description')}</p>
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
  );

  // One doctor's calendar: without the doctors to choose from there is nothing to show.
  if (!doctors.available) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
        {header}
        <p role="status" className="text-muted-foreground">
          {t('calendar.needsDoctors')}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      {header}

      <div className="flex flex-wrap items-end gap-4">
        <label className={`${field} min-w-52`}>
          {t('filters.doctor')}
          <select
            value={doctorId}
            onChange={(event) => setChosenDoctor(event.target.value)}
            disabled={!doctors.isSuccess || doctors.data.length === 0}
            className={control}
          >
            {(doctors.data ?? []).map((doctor) => (
              <option key={doctor.id} value={doctor.id}>
                {doctor.id === mine?.id ? t('filters.me', { name: doctor.name }) : doctor.name}
              </option>
            ))}
          </select>
        </label>
        <label className={field}>
          {t('calendar.goTo')}
          <input
            type="date"
            value={day}
            // A cleared or half-typed date leaves the calendar where it is.
            onChange={(event) => event.target.value !== '' && setDay(event.target.value)}
            className={control}
          />
        </label>
        {isDesktop && (
          <div
            role="group"
            aria-label={t('calendar.view')}
            className="inline-flex rounded-md border"
          >
            {(['day', 'week'] as const).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={view === option}
                onClick={() => setChosenView(option)}
                className={`h-9 px-3 text-sm font-medium first:rounded-l-md last:rounded-r-md pointer-coarse:h-11 ${
                  view === option ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
                }`}
              >
                {t(`calendar.views.${option}`)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label={t(view === 'day' ? 'calendar.previousDay' : 'calendar.previousWeek')}
          onClick={() => setDay(addDays(day, -step))}
          className={iconButton}
        >
          <ChevronLeft aria-hidden className="size-4" />
        </button>
        <button
          type="button"
          aria-label={t(view === 'day' ? 'calendar.nextDay' : 'calendar.nextWeek')}
          onClick={() => setDay(addDays(day, step))}
          className={iconButton}
        >
          <ChevronRight aria-hidden className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => setDay(today)}
          className="h-9 rounded-md border px-3 text-sm font-medium hover:bg-muted pointer-coarse:h-11"
        >
          {t('filters.today')}
        </button>
        <h2 className="text-lg font-medium" aria-live="polite">
          {heading}
        </h2>
      </div>

      {doctors.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(doctors.error))}
        </p>
      ) : doctors.isSuccess && doctorId === '' ? (
        <p role="status" className="text-muted-foreground">
          {t('calendar.noDoctors')}
        </p>
      ) : (
        <>
          <CalendarStatus
            loading={appointments.isPending || appointments.isPlaceholderData}
            error={appointments.isError ? tCommon(errorMessageKey(appointments.error)) : null}
            onRetry={() => void appointments.refetch()}
            count={appointments.isPlaceholderData ? undefined : items?.length}
            truncated={appointments.data?.truncated === true}
            empty={view === 'day' ? t('emptyDay') : t('empty')}
          />
          <Calendar
            label={t('calendar.label')}
            view={view}
            day={day}
            timezone={timezone}
            locale={locale}
            events={events}
            onSelectEvent={canOpenPatient ? openPatient : undefined}
            onOpenDay={(chosen) => {
              setDay(chosen);
              setChosenView('day');
            }}
          />
        </>
      )}
    </div>
  );
}

function CalendarStatus({
  loading,
  error,
  onRetry,
  count,
  truncated,
  empty,
}: {
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  count: number | undefined;
  truncated: boolean;
  empty: string;
}) {
  const { t } = useTranslation('appointments');
  if (error !== null) {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
        {error}
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('calendar.retry')}
        </Button>
      </div>
    );
  }
  return (
    <p role="status" className="text-sm text-muted-foreground">
      {loading || count === undefined
        ? t('calendar.loading')
        : truncated
          ? t('calendar.truncated', { count: CALENDAR_MAX_APPOINTMENTS })
          : count === 0
            ? empty
            : t('count', { count })}
    </p>
  );
}
