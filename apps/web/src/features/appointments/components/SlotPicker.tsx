import { useEffect, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { useFieldError, useFieldValue, useSetFieldValue } from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import { useFreeSlots } from '../hooks/use-book-appointment';

/** How many later free times are offered when the chosen one was refused. */
const ALTERNATIVES = 3;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Why the time chosen before was refused: taken by someone else, or no longer in the hours. */
export interface SlotRefusal {
  reason: 'taken' | 'outside_hours';
  /** The start of the time refused. The next free times after it are offered. */
  after: string;
}

/**
 * The doctor's free times on the chosen day, as a group of buttons of which one is pressed: the
 * server works them out, and the one chosen goes in the form's `startsAt`. After a refusal the
 * next free times after the one refused are named, and marked in the list.
 */
export function SlotPicker({
  refused,
  firstDay,
  lastDay,
}: {
  refused?: SlotRefusal;
  /** The days the server offers times for, both included. */
  firstDay: string;
  lastDay: string;
}) {
  const { t } = useTranslation('appointments');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const legendId = useId();
  const messageId = useId();
  const doctorId = String(useFieldValue('doctorId') ?? '');
  const day = String(useFieldValue('day') ?? '');
  const chosen = String(useFieldValue('startsAt') ?? '');
  const setValue = useSetFieldValue();
  const error = useFieldError('startsAt');
  const inRange = DAY.test(day) && day >= firstDay && day <= lastDay;
  const slots = useFreeSlots(doctorId, day, inRange);
  const free = slots.data?.slots;

  // A time chosen and then booked by someone else is let go when the list is asked for again,
  // so the form never sends a time it no longer shows.
  const gone = chosen !== '' && free !== undefined && !free.some((s) => s.startsAt === chosen);
  useEffect(() => {
    if (gone) setValue('startsAt', '');
  }, [gone, setValue]);

  const alternatives =
    refused === undefined || free === undefined
      ? []
      : free
          .filter((slot) => Date.parse(slot.startsAt) > Date.parse(refused.after))
          .slice(0, ALTERNATIVES);
  const offered = new Set(alternatives.map((slot) => slot.startsAt));

  let body;
  if (doctorId === '' || day === '') {
    body = <p className="text-sm text-muted-foreground">{t('book.slots.chooseFirst')}</p>;
  } else if (!inRange) {
    body = <p className="text-sm text-muted-foreground">{t('book.slots.outOfRange')}</p>;
  } else if (free === undefined) {
    body = slots.isError ? null : (
      <p role="status" className="text-sm text-muted-foreground">
        {t('book.slots.loading')}
      </p>
    );
  } else if (free.length === 0) {
    body = <p className="text-sm text-muted-foreground">{t('book.slots.none')}</p>;
  } else {
    body = (
      <div className="flex flex-wrap gap-2">
        {free.map((slot) => (
          <Button
            key={slot.startsAt}
            type="button"
            variant={slot.startsAt === chosen ? 'default' : 'outline'}
            aria-pressed={slot.startsAt === chosen}
            onClick={() => setValue('startsAt', slot.startsAt)}
            className={
              offered.has(slot.startsAt) && slot.startsAt !== chosen
                ? 'ring-2 ring-primary pointer-coarse:h-11'
                : 'pointer-coarse:h-11'
            }
          >
            {format.time(slot.startsAt)}
          </Button>
        ))}
      </div>
    );
  }

  const describedBy = [refused && free ? messageId : null, error ? `${messageId}-error` : null]
    .filter(Boolean)
    .join(' ');

  return (
    <fieldset
      aria-labelledby={legendId}
      aria-describedby={describedBy || undefined}
      className="flex flex-col gap-2"
    >
      <legend id={legendId} className="text-sm font-medium">
        {t('book.slots.label')}
        <span aria-hidden className="text-destructive">
          {' *'}
        </span>
      </legend>
      {refused && free && (
        // Announced, not a second set of buttons: the times named are marked in the list below.
        <p
          id={messageId}
          role="status"
          className="rounded-md border border-destructive/40 p-3 text-sm"
        >
          {alternatives.length > 0
            ? t(`book.refused.${refused.reason}.alternatives`, {
                times: alternatives.map((slot) => format.time(slot.startsAt)).join(', '),
              })
            : t(`book.refused.${refused.reason}.noneLater`)}
        </p>
      )}
      {body}
      {slots.isError && (
        // A failed refresh keeps the times already shown; a first load that failed shows this alone.
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(slots.error))}
          </p>
          <Button type="button" variant="outline" onClick={() => void slots.refetch()}>
            {t('book.slots.retry')}
          </Button>
        </div>
      )}
      {error && (
        <p id={`${messageId}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}
