import { Ban, Check, ChevronLeft, ChevronRight, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Can, usePermission } from '@/access';
import { useSession } from '@/app/session';
import { useDoctorOptions } from '@/features/doctors';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { useIsDesktop } from '@/shared/hooks/use-is-desktop';
import { Calendar, type CalendarEventItem, type CalendarView } from '@/shared/ui/calendar';
import { addDays, visibleDays, weekStartFor } from '@/shared/ui/calendar/zoned';
import { todayIn, utcToZoned, type DayString } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import { ViewSwitch } from '../components/ViewSwitch';
import {
  CALENDAR_MAX_APPOINTMENTS,
  useCalendarAppointments,
} from '../hooks/use-calendar-appointments';
import { bookableDays } from '../schemas';
import type { AppointmentStatus } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';
const field = 'flex min-w-40 flex-col gap-1 text-sm font-medium';
const iconButton =
  'inline-flex size-9 items-center justify-center rounded-md border hover:bg-muted pointer-coarse:size-11';

/** Not by colour alone: a sign for each status but the usual one, said by the block's name. */
const STATUS_ICON: Partial<Record<AppointmentStatus, CalendarEventItem['icon']>> = {
  completed: Check,
  cancelled: Ban,
  no_show: TriangleAlert,
};

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
  // A choice no longer listed (the doctor left, or stopped practising) falls back as at first,
  // so the calendar never shows one doctor under another's name in the choice.
  const chosen = doctors.data?.some((doctor) => doctor.id === chosenDoctor) ? chosenDoctor : null;
  const doctorId = chosen ?? mine?.id ?? doctors.data?.[0]?.id ?? '';
  const canBook = usePermission('appointment:create');

  const { from, to } = visibleDays(view, day, weekStartFor(locale));
  const appointments = useCalendarAppointments({ from, to, doctorId }, doctors.available);

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
        icon: STATUS_ICON[item.status],
        // With whom and the status, said after the block's own text, which may be too narrow
        // to hold them.
        label: t('calendar.eventLabel', {
          doctor: item.doctorName,
          status: t(`status.${item.status}`),
        }),
      })),
    [items, t],
  );

  // The appointment's own screen, by id: its patient is one link away from there.
  const openAppointment = (id: string) => navigate(`/appointments/${id}`);
  // A free time opens booking with the doctor, the day and the time chosen: ids and a time only.
  // Only a time booking takes: today, not yet begun at the hospital, to the last day it books.
  // The server's free times still decide whether the doctor works then and nobody has it.
  const lastBookable = bookableDays(today).last;
  const nowAtHospital = utcToZoned(new Date().toISOString(), timezone).time;
  const canBookAt = (slotDay: DayString, time: string) =>
    slotDay >= today && slotDay <= lastBookable && (slotDay > today || time > nowAtHospital);
  const bookAt = (slotDay: DayString, time: string) =>
    navigate(
      `/appointments/new?${new URLSearchParams({ doctorId, day: slotDay, time }).toString()}`,
    );

  const step = view === 'day' ? 1 : 7;
  // The range shown, with the view, announced when either changes.
  const heading =
    view === 'day'
      ? t('calendar.dayHeading', { date: format.calendarDate(day) })
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
            // On a phone the hours scroll inside a grid that leaves room for the controls.
            height={isDesktop ? 640 : 'min(640px, 70dvh)'}
            onSelectEvent={openAppointment}
            onSelectSlot={canBook ? bookAt : undefined}
            canSelectSlot={canBookAt}
            busy={appointments.isPending || appointments.isPlaceholderData}
            slotAction={t('calendar.slotAction')}
            onNavigate={setDay}
            onOpenDay={(opened) => {
              setDay(opened);
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
