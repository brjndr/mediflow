import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Form, SelectField, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { todayIn, utcToZoned, zonedToUtc } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import { useScheduleStudy } from '../hooks/use-radiology';
import {
  lastScheduleDay,
  scheduleSchemaFor,
  SLOT_MINUTES,
  SLOT_TIMES,
  type ScheduleOutput,
  type ScheduleValues,
} from '../schemas';
import type { ImagingStudy, ImagingWorkItem } from '../types';

/** Refusals the person can do nothing about on this form, in words of their own. */
const REFUSED: Record<string, string> = {
  conflict: 'schedule.refused.conflict',
  invalid_transition: 'schedule.refused.notSchedulable',
  order_not_found: 'schedule.refused.gone',
};

/** Refusals of the time chosen: another time can be sent. */
const RETRY: Record<string, string> = {
  outside_window: 'schedule.refused.outsideWindow',
  invalid_slot: 'schedule.refused.invalidSlot',
};

const SLOT_MS = SLOT_MINUTES * 60_000;

/**
 * Scheduling the study of an imaging order (#96), or moving it to another slot: a day at the
 * hospital (today to 90 days ahead) and a start time on a 15-minute step, on the hospital's
 * clock. It opens on the study's own slot, or the next slot to come. Sent from the version the
 * worklist shows, so a study that moved meanwhile is refused (409 `conflict`) and the worklist
 * read again. Shown in place, with `data-panel-heading` for the panel's focus.
 */
export function ScheduleStudy({
  item,
  onClose,
  onScheduled,
}: {
  item: ImagingWorkItem;
  onClose: () => void;
  onScheduled: (study: ImagingStudy) => void;
}) {
  const { t } = useTranslation('radiology');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const today = todayIn(timezone);
  const schema = useMemo(() => scheduleSchemaFor(today), [today]);
  const schedule = useScheduleStudy();
  // Read once, when the panel opens: the study's own slot, or the next one to come.
  const [opening] = useState(() => {
    const own = item.study?.scheduledAt;
    const next = new Date((Math.floor(Date.now() / SLOT_MS) + 1) * SLOT_MS).toISOString();
    return utcToZoned(own && own > next ? own : next, timezone);
  });
  const form = useZodForm(schema, { day: opening.day, time: opening.time });

  const submit = async (values: ScheduleOutput) => {
    schedule.reset();
    try {
      const study = await schedule.mutateAsync({
        item,
        scheduledAt: zonedToUtc(values.day, values.time, timezone),
      });
      onScheduled(study);
    } catch {
      // Said from the mutation state.
    }
  };

  const code = isApiError(schedule.error) ? schedule.error.serverCode : undefined;
  const failure = schedule.error
    ? code !== undefined && (REFUSED[code] ?? RETRY[code])
      ? t(REFUSED[code] ?? RETRY[code] ?? '')
      : tCommon(errorMessageKey(schedule.error))
    : undefined;
  // The study changed or the order moved on meanwhile: what this panel would send is refused
  // again, so the button goes and focus goes to what it says. Closing shows the worklist as read
  // again.
  const refused = code !== undefined && REFUSED[code] !== undefined;
  const alert = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (refused) focusIfLost(alert.current);
  }, [refused]);
  const headingId = useId();
  const rescheduling = Boolean(item.study?.scheduledAt);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id={headingId} data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t(rescheduling ? 'schedule.headingMove' : 'schedule.heading', { study: item.itemName })}
      </h2>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted-foreground">{t('schedule.patient')}</dt>
          <dd>{item.patientName}</dd>
        </div>
        {item.patientDob && (
          <div>
            <dt className="text-muted-foreground">{t('schedule.dob')}</dt>
            <dd>{format.calendarDate(item.patientDob)}</dd>
          </div>
        )}
        <div>
          <dt className="text-muted-foreground">{t('schedule.modality')}</dt>
          <dd>{t(`modality.${item.modality}`)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('schedule.priority')}</dt>
          <dd>{t(`priority.${item.priority}`)}</dd>
        </div>
        {item.study?.scheduledAt && (
          <div>
            <dt className="text-muted-foreground">{t('schedule.now')}</dt>
            <dd>{format.dateTime(item.study.scheduledAt)}</dd>
          </div>
        )}
        {item.instructions && (
          <div className="sm:col-span-2">
            <dt className="text-muted-foreground">{t('schedule.instructions')}</dt>
            <dd className="break-words">{item.instructions}</dd>
          </div>
        )}
      </dl>
      <Form form={form} onSubmit={submit}>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <TextField<ScheduleValues>
            name="day"
            type="date"
            label={t('schedule.day')}
            required
            min={today}
            max={lastScheduleDay(today)}
          />
          <SelectField<ScheduleValues>
            name="time"
            label={t('schedule.time')}
            hint={t('schedule.timeHint')}
            required
            options={SLOT_TIMES.map((time) => ({ value: time, label: time }))}
          />
        </div>
        {failure && (
          <p
            ref={alert}
            role="alert"
            tabIndex={-1}
            className="text-sm text-destructive outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {failure}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          {!refused && (
            <SubmitButton pending={schedule.isPending}>
              {schedule.isPending ? t('schedule.submitting') : t('schedule.submit')}
            </SubmitButton>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </Form>
    </section>
  );
}
