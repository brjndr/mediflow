// The keyboard and screen-reader model of the time grid, laid over the calendar library's own
// markup. Part of the calendar chunk: imported by `./calendar` only.
import { logger } from '@/shared/lib/logger';
import type { DayString } from '@/shared/utils/timezone';
import { addDays } from './zoned';

/**
 * The grid is one Tab stop. Inside it the arrow keys, Home, End, Page Up and Page Down move
 * between "stops": each block, and each quarter hour that no block covers, in time order within
 * a day.
 *
 * The library draws a day as a column, so the grid's rows are days (`role="row"`, named by the
 * day) and its cells are the stops (`role="gridcell"`). This is the reverse of the usual grid,
 * where Up and Down change rows, and a screen reader's own table commands follow the markup, not
 * the keys. It is chosen knowingly: the markup is the library's, and every cell is named by its
 * full time and day, so nothing depends on how a screen reader reads rows and columns (#341).
 *
 * One resource only: a column is a day. Several doctors or theatres side by side (the library's
 * `resources`, #331) need columns mapped to a day and a resource first.
 */

/** The library draws a quarter-hour slot per row of each column, from midnight. */
export const SLOT_MINUTES = 15;
const SLOTS_A_DAY = (24 * 60) / SLOT_MINUTES;

export interface GridEvent {
  /** Where it starts and ends at the hospital: a day, and minutes from its midnight. */
  startDay: DayString;
  start: number;
  endDay: DayString;
  end: number;
  /** The block's accessible name. */
  name: string;
}

export interface GridModel {
  /** The days drawn, in the order of the library's columns. */
  days: DayString[];
  events: Map<string, GridEvent>;
  gridLabel: string;
  /** While the blocks of the days drawn are still loading. */
  busy: boolean;
  dayLabel: (day: DayString) => string;
  slotLabel: (day: DayString, minutes: number) => string;
}

/** Where the keyboard is: a day and a time, and the block there when it is on one. */
export interface Cursor {
  day: DayString;
  minutes: number;
  eventId?: string;
}

export interface Stop extends Cursor {
  element: HTMLElement;
}

export type StopsByDay = Map<DayString, Stop[]>;

function set(element: Element, name: string, value: string | null) {
  if (value === null) {
    if (element.hasAttribute(name)) element.removeAttribute(name);
  } else if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

function asStop(element: HTMLElement, name: string, cursor: Cursor) {
  set(element, 'role', 'gridcell');
  set(element, 'aria-label', name);
  set(element, 'data-day', cursor.day);
  set(element, 'data-minutes', String(cursor.minutes));
}

const NOT_A_STOP = ['role', 'aria-label', 'data-day', 'data-minutes', 'tabindex'];

/** The part of a block on one day: a block past midnight is drawn on both days. */
export function partOn(event: GridEvent, day: DayString): [number, number] | undefined {
  if (day < event.startDay || day > event.endDay) return undefined;
  const start = day === event.startDay ? event.start : 0;
  const end = day === event.endDay ? event.end : 24 * 60;
  return end > start || start === event.start ? [start, Math.max(end, start + 1)] : undefined;
}

let warnedSlots = false;

/**
 * Gives the library's markup its roles and names, and returns the stops of each day drawn, in
 * time order. Only attributes are changed, never nodes, so React's own updates are untouched.
 */
export function layout(root: HTMLElement, model: GridModel): StopsByDay {
  const stops: StopsByDay = new Map();
  const content = root.querySelector<HTMLElement>('.rbc-time-content');
  if (!content) return stops;
  set(content, 'role', 'grid');
  set(content, 'aria-label', model.gridLabel);
  set(content, 'aria-busy', model.busy ? 'true' : null);
  // The hours beside the grid: every stop says its own time.
  content.querySelectorAll(':scope > .rbc-time-gutter').forEach((gutter) => {
    set(gutter, 'aria-hidden', 'true');
  });

  const columns = content.querySelectorAll<HTMLElement>(':scope > .rbc-day-slot');
  columns.forEach((column, index) => {
    const day = model.days[index];
    if (day === undefined) return;
    set(column, 'role', 'row');
    set(column, 'aria-label', model.dayLabel(day));
    column
      .querySelectorAll(':scope > .rbc-timeslot-group, :scope > .rbc-events-container')
      .forEach((part) => set(part, 'role', 'none'));
    column
      .querySelectorAll('.rbc-current-time-indicator')
      .forEach((line) => set(line, 'aria-hidden', 'true'));

    const dayStops: Stop[] = [];
    const covered: [number, number][] = [];
    column.querySelectorAll<HTMLElement>('.rbc-event[data-event-id]').forEach((element) => {
      const id = element.dataset.eventId ?? '';
      const event = model.events.get(id);
      const part = event && partOn(event, day);
      if (!event || !part) {
        // Nothing of it on this day (it ends at midnight): not a stop, and not a Tab stop either.
        for (const name of ['role', 'tabindex']) set(element, name, null);
        set(element, 'aria-hidden', 'true');
        return;
      }
      const stop = { day, minutes: part[0], eventId: id };
      asStop(element, event.name, stop);
      dayStops.push({ ...stop, element });
      covered.push(part);
    });

    const slots = column.querySelectorAll<HTMLElement>('.rbc-time-slot');
    // A day the browser's own clock lengthens or shortens (its daylight-saving change) is drawn
    // with more or fewer slots, whose times would be an hour out: only its blocks are stops.
    const regular = slots.length === SLOTS_A_DAY;
    if (!regular && !warnedSlots) {
      warnedSlots = true;
      logger.warn('calendar.irregular_day', { count: slots.length });
    }
    slots.forEach((element, slot) => {
      const minutes = slot * SLOT_MINUTES;
      const isCovered = covered.some(
        ([start, end]) => start < minutes + SLOT_MINUTES && end > minutes,
      );
      if (!regular || isCovered) {
        // Under a block, the block is the stop for that time.
        for (const name of NOT_A_STOP) set(element, name, null);
        return;
      }
      const stop = { day, minutes };
      asStop(element, model.slotLabel(day, minutes), stop);
      dayStops.push({ ...stop, element });
    });

    // In time order; at one time a block first, and blocks by id, so the order never changes.
    dayStops.sort(
      (a, b) =>
        a.minutes - b.minutes ||
        Number(b.eventId !== undefined) - Number(a.eventId !== undefined) ||
        (a.eventId ?? '').localeCompare(b.eventId ?? ''),
    );
    stops.set(day, dayStops);
  });
  return stops;
}

/** The stop at the cursor: its block, or the last stop that starts at or before its time. */
export function resolve(stops: StopsByDay, cursor: Cursor): Stop | undefined {
  const day = stops.get(cursor.day);
  if (!day || day.length === 0) return undefined;
  if (cursor.eventId !== undefined) {
    const block = day.find((stop) => stop.eventId === cursor.eventId);
    if (block) return block;
  }
  let found = day[0];
  for (const stop of day) {
    if (stop.minutes <= cursor.minutes) found = stop;
    else break;
  }
  return found;
}

const toCursor = ({ day, minutes, eventId }: Stop): Cursor =>
  eventId === undefined ? { day, minutes } : { day, minutes, eventId };

/**
 * Where a key moves the cursor, and whether that is past the days drawn. Undefined for a key the
 * grid does not handle.
 */
export function move(
  key: string,
  cursor: Cursor,
  stops: StopsByDay,
  rangeDays: number,
): { cursor: Cursor; outside: boolean } | undefined {
  const day = stops.get(cursor.day) ?? [];
  const current = resolve(stops, cursor);
  const index = current ? day.indexOf(current) : -1;
  const toDay = (by: number) => {
    const next = addDays(cursor.day, by);
    return { cursor: { day: next, minutes: cursor.minutes }, outside: !stops.has(next) };
  };
  const within = (stop: Stop | undefined) =>
    stop ? { cursor: toCursor(stop), outside: false } : { cursor, outside: false };

  switch (key) {
    case 'ArrowUp':
      return within(day[Math.max(index - 1, 0)]);
    case 'ArrowDown':
      return within(day[Math.min(index + 1, day.length - 1)]);
    case 'Home':
      return within(day[0]);
    case 'End':
      return within(day.at(-1));
    case 'ArrowLeft':
      return toDay(-1);
    case 'ArrowRight':
      return toDay(1);
    case 'PageUp':
      return { ...toDay(-rangeDays), outside: true };
    case 'PageDown':
      return { ...toDay(rangeDays), outside: true };
    default:
      return undefined;
  }
}

/** Minutes from midnight as `HH:mm`. */
export function clockTime(minutes: number): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}
