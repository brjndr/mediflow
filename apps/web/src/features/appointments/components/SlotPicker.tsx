import { useEffect, useId, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { useFieldError, useFieldFocusRef, useFieldValue, useSetFieldValue } from '@/shared/ui/form';
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
  preferred,
  firstDay,
  lastDay,
}: {
  refused?: SlotRefusal;
  /**
   * A time asked for (from the calendar): chosen when the first free times of that doctor and
   * day arrive and list it. Asked once: a later list, or another doctor or day, never chooses it.
   */
  preferred?: { doctorId: string; day: string; startsAt: string };
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
  // Not a kit field: a failed submit focuses its first time, or the group when there is none.
  const focusRef = useFieldFocusRef('startsAt');
  const inRange = DAY.test(day) && day >= firstDay && day <= lastDay;
  const slots = useFreeSlots(doctorId, day, inRange);
  const free = slots.data?.slots;

  // A time chosen and then booked by someone else is let go when the list is asked for again,
  // so the form never sends a time it no longer shows.
  const gone = chosen !== '' && free !== undefined && !free.some((s) => s.startsAt === chosen);
  useEffect(() => {
    if (gone) setValue('startsAt', '');
  }, [gone, setValue]);

  // The time asked for is chosen once, if free when its list arrives; taken, nothing is chosen.
  const preferredAsked = useRef(false);
  useEffect(() => {
    if (preferredAsked.current || preferred === undefined || free === undefined) return;
    preferredAsked.current = true;
    if (preferred.doctorId !== doctorId || preferred.day !== day) return;
    // As instants: the server may write the same time another way (with or without milliseconds).
    const asked = Date.parse(preferred.startsAt);
    const slot = free.find((candidate) => Date.parse(candidate.startsAt) === asked);
    if (slot) setValue('startsAt', slot.startsAt);
  }, [preferred, free, doctorId, day, setValue]);

  const alternatives =
    refused === undefined || free === undefined
      ? []
      : free
          .filter((slot) => Date.parse(slot.startsAt) > Date.parse(refused.after))
          .slice(0, ALTERNATIVES);
  const offered = new Set(alternatives.map((slot) => slot.startsAt));

  // What the list is doing, said by a screen reader as it changes (loading, how many, none), from
  // a region that is always there: one added with its text already in it may not be read.
  let status = '';
  let body;
  if (doctorId === '' || day === '') {
    body = <p className="text-sm text-muted-foreground">{t('book.slots.chooseFirst')}</p>;
  } else if (!inRange) {
    body = <p className="text-sm text-muted-foreground">{t('book.slots.outOfRange')}</p>;
  } else if (free === undefined) {
    if (!slots.isError) status = t('book.slots.loading');
  } else if (free.length === 0) {
    status = t('book.slots.none');
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
  // How many there are is said only once they arrive, not drawn: the buttons show it.
  const count =
    free !== undefined && free.length > 0 && inRange && doctorId !== '' && day !== ''
      ? t('book.slots.count', { count: free.length })
      : '';

  const describedBy = [refused && free ? messageId : null, error ? `${messageId}-error` : null]
    .filter(Boolean)
    .join(' ');

  return (
    <fieldset
      ref={focusRef}
      // Focused on a failed submit when it holds no time to focus.
      tabIndex={-1}
      aria-labelledby={legendId}
      aria-describedby={describedBy || undefined}
      className="flex flex-col gap-2 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <legend id={legendId} className="text-sm font-medium">
        {t('book.slots.label')}
        <span aria-hidden className="text-destructive">
          {' *'}
        </span>
        {/* A group of buttons cannot be marked required: it is said instead. */}{' '}
        <span className="sr-only">{t('book.slots.required')}</span>
      </legend>
      <div role="status" className="flex flex-col gap-2">
        {refused && free && (
          // Said, not a second set of buttons: the times named are marked in the list below.
          <p id={messageId} className="rounded-md border border-destructive/40 p-3 text-sm">
            {alternatives.length > 0
              ? t(`book.refused.${refused.reason}.alternatives`, {
                  times: alternatives.map((slot) => format.time(slot.startsAt)).join(', '),
                })
              : t(`book.refused.${refused.reason}.noneLater`)}
          </p>
        )}
        {status && <p className="text-sm text-muted-foreground">{status}</p>}
        {count && <p className="sr-only">{count}</p>}
      </div>
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
