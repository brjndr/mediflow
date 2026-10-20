import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useFeatureFlag, usePermission } from '@/access';
import { useDoctorOptions } from '@/features/doctors';
import { errorMessageKey, isApiError } from '@/shared/api';
import { usePanelFocus } from '@/shared/hooks/use-panel-focus';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import {
  Form,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
  useZodForm,
} from '@/shared/ui/form';
import { todayIn } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import {
  useCancelFollowUp,
  useCreateFollowUp,
  useEncounterFollowUps,
} from '../hooks/use-follow-ups';
import {
  cancelSchema,
  DUE_DAYS_AHEAD,
  followUpFormSchemaFor,
  NOTE_MAX,
  REASON_MAX,
  shiftDay,
  toFollowUpCreate,
  type CancelValues,
  type FollowUpValues,
} from '../schemas';
import type { FollowUp } from '../types';
import { BookFollowUp } from './BookFollowUp';
import { FollowUpState } from './FollowUpState';

const REFUSED: Record<string, string> = {
  encounter_not_open: 'refused.notOpen',
  follow_up_exists: 'refused.exists',
  outside_window: 'refused.outsideWindow',
  unknown_doctor: 'refused.unknownDoctor',
  conflict: 'refused.conflict',
  invalid_transition: 'refused.notDue',
  follow_up_not_found: 'refused.gone',
};

function useRefusal(error: unknown) {
  const { t } = useTranslation('follow_ups');
  const { t: tCommon } = useTranslation();
  if (!error) return undefined;
  const code = isApiError(error) ? error.serverCode : undefined;
  const key = code === undefined ? undefined : REFUSED[code];
  return key ? t(key) : tCommon(errorMessageKey(error));
}

/** What the consultation tells the panel: ids and values, never the record. */
export interface FollowUpPanelProps {
  encounterId: string;
  /** Only an open encounter takes a new follow-up. */
  open: boolean;
  /** A cancelled encounter's follow-ups are shown, and nothing more is done with them. */
  cancelled: boolean;
}

/**
 * The follow-up of a consultation (#88), for `followUp:read`: when the patient should come back,
 * to whom, and whether it is booked, with the cancelled ones kept below. `followUp:create` sets
 * one while the encounter is open (one at a time) and cancels a due one; `appointment:create`,
 * with the appointments switch on, books it here (the desk books it from the due list otherwise).
 */
export function FollowUpPanel({ encounterId, open, cancelled }: FollowUpPanelProps) {
  const { t } = useTranslation('follow_ups');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const headingId = useId();
  const canRead = usePermission('followUp:read');
  const canCreate = usePermission('followUp:create');
  const canCreateAppointments = usePermission('appointment:create');
  const appointmentsOn = useFeatureFlag('appointments');
  const canBook = canCreateAppointments && appointmentsOn;
  const followUps = useEncounterFollowUps(canRead ? encounterId : '');
  const box = useRef<HTMLElement>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const [message, setMessage] = useState({ text: '', count: 0 });
  const [panel, setPanel] = useState<{ kind: 'book' | 'cancel'; id: string } | null>(null);
  usePanelFocus(panel ? `${panel.kind}:${panel.id}` : null, box, status);
  const rows = useMemo(
    () => followUps.data?.pages.flatMap((page) => page.items) ?? [],
    [followUps.data],
  );
  const current = rows.find((row) => row.state !== 'cancelled');
  const past = rows.filter((row) => row.state === 'cancelled');
  const say = (text: string) => setMessage((now) => ({ text, count: now.count + 1 }));
  useLayoutEffect(() => {
    if (message.count > 0) focusIfLost(status.current);
  }, [message]);

  if (!canRead) return null;

  return (
    <section ref={box} aria-labelledby={headingId} className="flex flex-col gap-4">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('panel.heading')}
      </h2>
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className="text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 empty:hidden"
      >
        {message.text}
      </p>
      {followUps.isPending ? (
        <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
      ) : followUps.isError ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(followUps.error))}
          </p>
          <Button type="button" variant="outline" onClick={() => void followUps.refetch()}>
            {tCommon('grid.retry')}
          </Button>
        </div>
      ) : (
        <>
          {current ? (
            <div className="flex flex-col gap-2 rounded-md border p-3 text-sm">
              <p className="font-medium">
                {t('panel.comeBack', {
                  day: format.calendarDate(current.dueOn),
                  doctor: current.doctorName,
                })}
              </p>
              <p>
                <FollowUpState followUp={current} />
              </p>
              {current.note && <p className="whitespace-pre-line">{current.note}</p>}
              <p className="text-muted-foreground">
                {t('panel.setBy', {
                  name: current.createdByName,
                  time: format.dateTime(current.createdAt),
                })}
              </p>
              {current.state === 'due' && !cancelled && !panel && (
                <div className="flex flex-wrap gap-2">
                  {canBook && (
                    <Button
                      type="button"
                      onClick={() => setPanel({ kind: 'book', id: current.id })}
                    >
                      {t('panel.book')}
                    </Button>
                  )}
                  {canCreate && (
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setPanel({ kind: 'cancel', id: current.id })}
                    >
                      {t('panel.cancel')}
                    </Button>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t('panel.none')}</p>
          )}
          {current && panel?.kind === 'book' && (
            <BookFollowUp
              followUp={current}
              onClose={() => setPanel(null)}
              onBooked={(booked) => {
                setPanel(null);
                say(
                  t('booked', {
                    time: format.dateTime(booked.appointmentStartsAt ?? ''),
                    doctor: booked.doctorName,
                  }),
                );
              }}
            />
          )}
          {current && panel?.kind === 'cancel' && (
            <CancelFollowUp
              followUp={current}
              onClose={() => setPanel(null)}
              onCancelled={() => {
                setPanel(null);
                say(t('cancelledNow'));
              }}
            />
          )}
          {!current && canCreate && open && (
            <SetFollowUp encounterId={encounterId} onSet={() => say(t('form.set'))} />
          )}
          {past.length > 0 && (
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              {past.map((row) => (
                <li key={row.id}>
                  {t('panel.cancelledOne', {
                    day: format.calendarDate(row.dueOn),
                    doctor: row.doctorName,
                    reason: row.cancelReason ?? '',
                  })}
                </li>
              ))}
            </ul>
          )}
          {followUps.hasNextPage && (
            <Button
              type="button"
              variant="outline"
              className="self-start"
              aria-disabled={followUps.isFetchingNextPage}
              onClick={() => {
                if (!followUps.isFetchingNextPage) void followUps.fetchNextPage();
              }}
            >
              {tCommon('grid.loadMore')}
            </Button>
          )}
        </>
      )}
    </section>
  );
}

function CancelFollowUp({
  followUp,
  onClose,
  onCancelled,
}: {
  followUp: FollowUp;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const { t } = useTranslation('follow_ups');
  const cancel = useCancelFollowUp();
  const form = useZodForm(cancelSchema, { reason: '' });
  const failure = useRefusal(cancel.error);
  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <h3 data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('cancel.heading')}
      </h3>
      <Form
        form={form}
        onSubmit={(values: CancelValues) =>
          cancel.mutate({ followUp, reason: values.reason }, { onSuccess: onCancelled })
        }
      >
        <TextField<CancelValues>
          name="reason"
          label={t('cancel.reason')}
          required
          maxLength={REASON_MAX}
          autoComplete="off"
        />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={cancel.isPending}>{t('cancel.submit')}</SubmitButton>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </Form>
    </div>
  );
}

/** In how many days the patient comes back, offered as a start: the day can be typed too. */
const QUICK_DAYS = [7, 14, 30] as const;

/** Sets the follow-up: the day the patient should come back, to whom, and a note for the desk. */
function SetFollowUp({ encounterId, onSet }: { encounterId: string; onSet: () => void }) {
  const { t } = useTranslation('follow_ups');
  const headingId = useId();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const today = todayIn(timezone);
  const schema = useMemo(() => followUpFormSchemaFor(today), [today]);
  const create = useCreateFollowUp(encounterId);
  const doctors = useDoctorOptions();
  const blank: FollowUpValues = { dueOn: shiftDay(today, QUICK_DAYS[0]), doctorId: '', note: '' };
  const form = useZodForm(schema, blank);
  const failure = useRefusal(create.error);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h3 id={headingId} className="font-semibold">
        {t('form.heading')}
      </h3>
      <Form
        form={form}
        onSubmit={(values) =>
          create.mutate(toFollowUpCreate(values), {
            onSuccess: () => {
              form.reset(blank);
              onSet();
            },
          })
        }
      >
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('form.quick')}>
          {QUICK_DAYS.map((days) => (
            <Button
              key={days}
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                form.setValue('dueOn', shiftDay(today, days), {
                  shouldValidate: form.formState.isSubmitted,
                })
              }
            >
              {t('form.inDays', { count: days })}
            </Button>
          ))}
        </div>
        <TextField<FollowUpValues>
          name="dueOn"
          type="date"
          label={t('form.dueOn')}
          required
          min={today}
          max={shiftDay(today, DUE_DAYS_AHEAD)}
        />
        {doctors.available && (
          <SelectField<FollowUpValues>
            name="doctorId"
            label={t('form.doctor')}
            placeholder={t('form.sameDoctor')}
            options={(doctors.data ?? []).map((doctor) => ({
              value: doctor.id,
              label: doctor.name,
            }))}
          />
        )}
        <TextAreaField<FollowUpValues>
          name="note"
          label={t('form.note')}
          hint={t('form.noteHint')}
          maxLength={NOTE_MAX}
          rows={2}
        />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        <SubmitButton pending={create.isPending} className="self-start">
          {create.isPending ? t('form.saving') : t('form.submit')}
        </SubmitButton>
      </Form>
    </section>
  );
}
