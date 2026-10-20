import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useFeatureFlag, usePermission } from '@/access';
import { useSession } from '@/app/session';
import { useDoctorOptions } from '@/features/doctors';
import { errorMessageKey } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { maskMrn } from '@/shared/utils/mask';
import { todayIn } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import { BookFollowUp } from '../components/BookFollowUp';
import { FollowUpState } from '../components/FollowUpState';
import { useFollowUps } from '../hooks/use-follow-ups';
import { FOLLOW_UP_STATES } from '../schemas';
import type { FollowUp, FollowUpState as State } from '../types';

const field =
  'h-9 w-full rounded-md border bg-background px-3 text-base md:text-sm pointer-coarse:h-11 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

/**
 * Follow-ups (`follow-ups`, #88), for `followUp:read`: the follow-up due list. The follow-ups the
 * caller may see, the soonest due first, those still to book by default, filtered by doctor and
 * by the last day due. The desk books one here as an appointment, for `appointment:create` with
 * the appointments switch on. Opens on the signed-in doctor's own, as the consultations do.
 */
export default function FollowUpList() {
  const { t } = useTranslation('follow_ups');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const navigate = useNavigate();
  const doctorFieldId = useId();
  const stateFieldId = useId();
  const dueToFieldId = useId();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const today = todayIn(timezone);
  const session = useSession();
  const doctors = useDoctorOptions();
  const appointmentsOn = useFeatureFlag('appointments');
  const canReadEncounters = usePermission('encounter:read');
  const mine = doctors.data?.find((doctor) => doctor.userId === session?.user.id);
  // Null until someone chooses: a doctor sees their own first, everyone else the whole hospital's.
  const [chosenDoctor, setChosenDoctor] = useState<string | null>(null);
  const doctorId = chosenDoctor ?? mine?.id ?? '';
  const [state, setState] = useState<State | ''>('due');
  const [dueTo, setDueTo] = useState('');
  const settled = !doctors.available || doctors.isSuccess || doctors.isError;
  const followUps = useFollowUps(
    {
      state,
      dueFrom: '',
      // A half-typed day asks for nothing new.
      dueTo: /^\d{4}-\d{2}-\d{2}$/.test(dueTo) ? dueTo : '',
      doctorId,
    },
    // Until the doctors are known, it is not known whose to show first.
    { enabled: settled },
  );
  const rows = useMemo(
    () => followUps.data?.pages.flatMap((page) => page.items) ?? [],
    [followUps.data],
  );
  const total = followUps.isPlaceholderData ? undefined : followUps.data?.pages[0]?.total;

  const box = useRef<HTMLDivElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  // The row being booked is read from the list as it is now, so a retry after a conflict sends
  // the version the list read again, never the one the panel opened with.
  const [bookingId, setBookingId] = useState<string | null>(null);
  const booking = bookingId === null ? undefined : rows.find((row) => row.id === bookingId);
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  const shown = booking?.state === 'due' ? booking : undefined;
  // Booked or cancelled meanwhile, or gone from this list: the panel closes and the status says so.
  const lost = bookingId !== null && !shown && followUps.isSuccess && !followUps.isFetching;
  usePanelFocus(shown ? bookingId : null, box, status);
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  const columns = useMemo<GridColumn<FollowUp>[]>(
    () => [
      {
        id: 'patient',
        header: t('list.columns.patient'),
        value: (row) => row.patientName,
        hideable: false,
      },
      { id: 'mrn', header: t('list.columns.mrn'), value: (row) => row.patientMrn, mask: maskMrn },
      {
        id: 'due',
        header: t('list.columns.due'),
        value: (row) => format.calendarDate(row.dueOn),
      },
      { id: 'doctor', header: t('list.columns.doctor'), value: (row) => row.doctorName },
      {
        id: 'state',
        header: t('list.columns.state'),
        value: (row) => t(`state.${row.state}`),
        render: (row) => <FollowUpState followUp={row} today={today} />,
      },
      { id: 'note', header: t('list.columns.note'), value: (row) => row.note ?? '' },
    ],
    [t, format, today],
  );

  const actions = useMemo<GridAction<FollowUp>[]>(
    () => [
      ...(appointmentsOn
        ? [
            {
              id: 'book',
              label: t('list.book'),
              requires: 'appointment:create',
              disabled: (row: FollowUp) => row.state !== 'due',
              onSelect: (row: FollowUp) => setBookingId(row.id),
            } satisfies GridAction<FollowUp>,
          ]
        : []),
      ...(canReadEncounters
        ? [
            {
              id: 'consultation',
              label: t('list.openConsultation'),
              onSelect: (row: FollowUp) => navigate(`/encounters/${row.encounterId}`),
            } satisfies GridAction<FollowUp>,
          ]
        : []),
    ],
    [t, appointmentsOn, canReadEncounters, navigate],
  );

  return (
    <div ref={box} className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">{t('list.heading')}</h1>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3 lg:max-w-3xl">
        {doctors.available && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={doctorFieldId} className="text-sm font-medium">
              {t('list.doctor')}
            </label>
            <select
              id={doctorFieldId}
              className={field}
              value={doctorId}
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
          <label htmlFor={stateFieldId} className="text-sm font-medium">
            {t('list.state')}
          </label>
          <select
            id={stateFieldId}
            className={field}
            value={state}
            onChange={(event) => setState(event.target.value as State | '')}
          >
            {FOLLOW_UP_STATES.map((each) => (
              <option key={each} value={each}>
                {t(`state.${each}`)}
              </option>
            ))}
            <option value="">{t('list.allStates')}</option>
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={dueToFieldId} className="text-sm font-medium">
            {t('list.dueTo')}
          </label>
          <input
            id={dueToFieldId}
            type="date"
            className={field}
            value={dueTo}
            onChange={(event) => setDueTo(event.target.value)}
          />
        </div>
      </div>
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {[
          lost ? t('list.noLongerDue') : message.text,
          total === undefined ? '' : t('list.count', { count: total }),
        ]
          .filter(Boolean)
          .join(' ')}
      </p>
      <DataGrid
        label={t('list.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.patientName}
        actions={actions}
        status={!settled || followUps.isPending ? 'loading' : followUps.isError ? 'error' : 'ready'}
        errorMessage={followUps.isError ? tCommon(errorMessageKey(followUps.error)) : undefined}
        onRetry={() => void followUps.refetch()}
        emptyMessage={t('list.empty')}
        hasNextPage={followUps.hasNextPage && !followUps.isPlaceholderData}
        total={total}
        loadingMore={followUps.isFetchingNextPage}
        onLoadMore={() => void followUps.fetchNextPage()}
      />
      {shown && (
        <BookFollowUp
          followUp={shown}
          headingLevel={2}
          onClose={() => setBookingId(null)}
          onBooked={(booked) => {
            setBookingId(null);
            say(
              t('booked', {
                time: format.dateTime(booked.appointmentStartsAt ?? ''),
                doctor: booked.doctorName,
              }),
            );
          }}
        />
      )}
    </div>
  );
}
