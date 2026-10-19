// The calendar library and its styles. Loaded on demand through `./index`, in its own chunk
// (`calendar`, which may use the heavy budget): never part of the initial load.
import {
  cloneElement,
  isValidElement,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import {
  Calendar as BigCalendar,
  DateLocalizer,
  type Components,
  type EventProps,
  type EventWrapperProps,
  type Formats,
} from 'react-big-calendar';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import './calendar.css';
import type { DayString } from '@/shared/utils/timezone';
import type { CalendarEventItem, CalendarProps } from './index';
import {
  clockTime,
  layout,
  move,
  resolve,
  type Cursor,
  type GridEvent,
  type GridModel,
  type StopsByDay,
} from './keyboard';
import { addDays, dayToWall, toWall, visibleDays, wallToDay, weekStartFor } from './zoned';

interface WallEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  tone: NonNullable<CalendarEventItem['tone']>;
  hint?: string;
  label?: string;
  icon?: CalendarEventItem['icon'];
}

/**
 * A localizer that formats with `Intl` in the hospital's locale, so no date library's locale
 * files are needed. The dates it is given are wall dates (see `./zoned`), so they are formatted in
 * the browser's own timezone, which shows the hospital's clock.
 */
function makeFormat(locale: string, options: Intl.DateTimeFormatOptions) {
  try {
    return new Intl.DateTimeFormat(locale, options);
  } catch {
    return new Intl.DateTimeFormat('en', options);
  }
}

function intlLocalizer(locale: string): DateLocalizer {
  const make = (options: Intl.DateTimeFormatOptions) => makeFormat(locale, options);
  const time = make({ timeStyle: 'short' });
  const hour = make({ hour: 'numeric' });
  const weekdayDay = make({ weekday: 'short', day: 'numeric' });
  const fullDay = make({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const shortDay = make({ day: 'numeric', month: 'short' });
  const weekday = make({ weekday: 'short' });
  const monthYear = make({ month: 'long', year: 'numeric' });
  const dayOfMonth = make({ day: 'numeric' });

  const range =
    (format: Intl.DateTimeFormat) =>
    ({ start, end }: { start: Date; end: Date }) =>
      `${format.format(start)} – ${format.format(end)}`;

  const formats: Formats = {
    dateFormat: (date) => dayOfMonth.format(date),
    dayFormat: (date) => weekdayDay.format(date),
    weekdayFormat: (date) => weekday.format(date),
    timeGutterFormat: (date) => hour.format(date),
    monthHeaderFormat: (date) => monthYear.format(date),
    dayHeaderFormat: (date) => fullDay.format(date),
    dayRangeHeaderFormat: range(shortDay),
    agendaHeaderFormat: range(shortDay),
    agendaDateFormat: (date) => shortDay.format(date),
    agendaTimeFormat: (date) => time.format(date),
    agendaTimeRangeFormat: range(time),
    selectRangeFormat: range(time),
    eventTimeRangeFormat: range(time),
    eventTimeRangeStartFormat: ({ start }) => `${time.format(start)} –`,
    eventTimeRangeEndFormat: ({ end }) => `– ${time.format(end)}`,
  };
  const firstDay = weekStartFor(locale);
  return new DateLocalizer({
    formats,
    firstOfWeek: () => firstDay,
    // Every format above is a function; a string format would be a mistake here.
    format: (value) => String(value),
  });
}

const TONE_CLASS: Record<WallEvent['tone'], string> = {
  primary: 'cal-event-primary',
  muted: 'cal-event-muted',
  struck: 'cal-event-struck',
  danger: 'cal-event-danger',
};

/**
 * The library marks its day headings and the all-day row with table roles (`columnheader`,
 * `row`, `rowgroup`) outside any table or grid, which tells assistive technology of a table that
 * is not there. Those roles are removed: the headings are read as text. The time grid gets its
 * own roles from `./keyboard`, which this leaves alone.
 */
const BROKEN_ROLES = '[role="columnheader"], [role="row"], [role="rowgroup"]';

function removeBrokenRoles(root: HTMLElement) {
  root.querySelectorAll(BROKEN_ROLES).forEach((element) => {
    if (element.closest('.rbc-time-content')) return;
    element.removeAttribute('role');
    element.removeAttribute('aria-sort');
  });
}

/**
 * What a block says, on one line so a fifteen-minute block of a week column can hold it: its
 * sign, the start and the title. Its accessible name is set by `./keyboard`. The library's own
 * two-line label is hidden by `calendar.css`.
 */
function eventContent(time: Intl.DateTimeFormat): Components<WallEvent>['event'] {
  return function EventContent({ event }: EventProps<WallEvent>) {
    const Icon = event.icon;
    return (
      <span className="cal-event-line">
        {Icon && <Icon aria-hidden className="cal-event-icon" />}
        <span className="font-medium">{time.format(event.start)}</span> {event.title}
      </span>
    );
  };
}

/** Marks each block with its id, so the keyboard model can find it among the library's nodes. */
function EventWrapper({
  event,
  children,
}: EventWrapperProps<WallEvent> & { children?: ReactNode }) {
  return isValidElement<Record<string, unknown>>(children)
    ? cloneElement(children, { 'data-event-id': event.id })
    : children;
}

/** Where the day opens when nothing is booked: the start of a usual working day. */
const OPENING_HOUR = 8;

const minutesOf = (wall: Date) => wall.getHours() * 60 + wall.getMinutes();

// Default export: loaded with React.lazy by `./index`.
export default function CalendarImpl({
  label,
  view,
  day,
  timezone,
  locale,
  events,
  onSelectEvent,
  onSelectSlot,
  canSelectSlot,
  slotAction,
  busy = false,
  onNavigate,
  onOpenDay,
  height = 640,
}: CalendarProps) {
  const { t } = useTranslation();
  const localizer = useMemo(() => intlLocalizer(locale), [locale]);
  const time = useMemo(() => makeFormat(locale, { timeStyle: 'short' }), [locale]);
  const dayName = useMemo(
    () => makeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }),
    [locale],
  );
  // Stable, so the library does not remount every block on each render.
  const components = useMemo<Components<WallEvent>>(
    () => ({ event: eventContent(time), eventWrapper: EventWrapper }),
    [time],
  );
  const root = useRef<HTMLElement>(null);

  const wallEvents = useMemo<WallEvent[]>(
    () =>
      events.map((event) => ({
        id: event.id,
        title: event.title,
        start: toWall(event.start, timezone),
        end: toWall(event.end, timezone),
        tone: event.tone ?? 'primary',
        hint: event.hint,
        label: event.label,
        icon: event.icon,
      })),
    [events, timezone],
  );

  const { from } = visibleDays(view, day, weekStartFor(locale));
  const rangeDays = view === 'day' ? 1 : 7;

  // Open the day at its first event, or at the start of a working day when it has none.
  const scrollToTime = useMemo(() => {
    const earliest = wallEvents.reduce<Date | undefined>(
      (first, event) =>
        first === undefined || minutesOf(event.start) < minutesOf(first) ? event.start : first,
      undefined,
    );
    const opening = dayToWall(day);
    opening.setHours(earliest ? earliest.getHours() : OPENING_HOUR, 0, 0, 0);
    return opening;
  }, [wallEvents, day]);

  const date = useMemo(() => dayToWall(day), [day]);

  // Whether a free time can be chosen: never while the blocks of the days drawn are loading,
  // when every time would look free.
  const selectable = useCallback(
    (slotDay: DayString, minutes: number) =>
      onSelectSlot !== undefined && !busy && (canSelectSlot?.(slotDay, clockTime(minutes)) ?? true),
    [onSelectSlot, busy, canSelectSlot],
  );

  // What the keyboard model needs. Rebuilt on each render and read by `apply`, which also runs
  // when the library changes its own nodes.
  const model = useMemo<GridModel & { home: Cursor }>(() => {
    const gridEvents = new Map<string, GridEvent>();
    let first: WallEvent | undefined;
    for (const event of wallEvents) {
      const startDay = wallToDay(event.start);
      if (startDay === day && (!first || minutesOf(event.start) < minutesOf(first.start))) {
        first = event;
      }
      // A block past midnight is drawn on each of its days (`showMultiDayTimes`); one that
      // ends at midnight ends on its own day.
      const endsAtMidnight = minutesOf(event.end) === 0 && wallToDay(event.end) > startDay;
      gridEvents.set(event.id, {
        startDay,
        start: minutesOf(event.start),
        endDay: endsAtMidnight ? addDays(wallToDay(event.end), -1) : wallToDay(event.end),
        end: endsAtMidnight ? 24 * 60 : minutesOf(event.end),
        // It starts with what the block shows (its start and title), so a voice command that
        // says the visible text reaches it (WCAG 2.5.3, Label in Name); the rest follows.
        name: t(event.label ? 'calendar.eventWithDetail' : 'calendar.event', {
          start: time.format(event.start),
          title: event.title,
          end: time.format(event.end),
          day: dayName.format(event.start),
          detail: event.label,
        }),
      });
    }
    const wallAt = (slotDay: DayString, minutes: number) => {
      const wall = dayToWall(slotDay);
      wall.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
      return wall;
    };
    // Named once per model: a week is 672 quarter hours, laid out again on every key.
    const dayNames = new Map<DayString, string>();
    const dayLabel = (columnDay: DayString) => {
      let name = dayNames.get(columnDay);
      if (name === undefined) {
        name = dayName.format(dayToWall(columnDay));
        dayNames.set(columnDay, name);
      }
      return name;
    };
    const slotNames = new Map<string, string>();
    return {
      days: Array.from({ length: rangeDays }, (_, i) => addDays(from, i)),
      events: gridEvents,
      gridLabel: label,
      busy,
      dayLabel,
      slotLabel: (slotDay, minutes) => {
        const key = `${slotDay}|${minutes}`;
        const known = slotNames.get(key);
        if (known !== undefined) return known;
        const values = { time: time.format(wallAt(slotDay, minutes)), day: dayLabel(slotDay) };
        const name =
          slotAction && selectable(slotDay, minutes)
            ? t('calendar.slotWithAction', { ...values, action: slotAction })
            : t('calendar.slot', values);
        slotNames.set(key, name);
        return name;
      },
      // Where the keyboard starts: the day's first block, or the start of a working day.
      home: first
        ? { day, minutes: minutesOf(first.start), eventId: first.id }
        : { day, minutes: OPENING_HOUR * 60 },
    };
  }, [wallEvents, day, from, rangeDays, label, busy, selectable, slotAction, t, time, dayName]);
  const modelRef = useRef(model);

  // Where the keyboard is; null until it has been somewhere in the days drawn.
  const cursor = useRef<Cursor | null>(null);
  const stops = useRef<StopsByDay>(new Map());
  // True while focus is in the grid: the stop at the cursor then keeps it when nodes change.
  const focused = useRef(false);

  const apply = useCallback(() => {
    const element = root.current;
    if (!element) return;
    removeBrokenRoles(element);
    stops.current = layout(element, modelRef.current);
    // A cursor on a day no longer drawn (the screen showed another range) starts again.
    if (cursor.current !== null && !stops.current.has(cursor.current.day)) cursor.current = null;
    const at = resolve(stops.current, cursor.current ?? modelRef.current.home);
    for (const dayStops of stops.current.values()) {
      for (const stop of dayStops) {
        const tabIndex = stop === at ? '0' : '-1';
        if (stop.element.getAttribute('tabindex') !== tabIndex) {
          stop.element.setAttribute('tabindex', tabIndex);
        }
      }
    }
    if (focused.current && at && document.activeElement !== at.element) {
      const active = document.activeElement;
      // Focus lost with a removed stop comes back; focus taken elsewhere is never pulled back.
      if (active === null || active === document.body || element.contains(active)) {
        at.element.focus();
      } else {
        focused.current = false;
      }
    }
  }, []);

  // After every render, and whenever the library adds or changes nodes of its own.
  useLayoutEffect(() => {
    modelRef.current = model;
    apply();
  });
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new MutationObserver(() => apply());
    observer.observe(element, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [apply]);

  const choose = (stop: Cursor) => {
    if (stop.eventId !== undefined) onSelectEvent?.(stop.eventId);
    else if (selectable(stop.day, stop.minutes)) onSelectSlot?.(stop.day, clockTime(stop.minutes));
  };

  const onFocus = (event: FocusEvent) => {
    const stop = stopAt(event.target);
    if (!stop) return;
    focused.current = true;
    const same =
      cursor.current?.day === stop.day &&
      cursor.current.minutes === stop.minutes &&
      cursor.current.eventId === stop.eventId;
    cursor.current = stop;
    // A move by key has laid the grid out already; a click or a tap moves the Tab stop here.
    if (!same) apply();
  };

  const onBlur = (event: FocusEvent) => {
    if (!focused.current) return;
    const next = event.relatedTarget;
    if (
      next instanceof Element &&
      next.closest('.rbc-time-content') &&
      root.current?.contains(next)
    ) {
      return;
    }
    const left = event.target;
    // A stop removed while focused (the range changed, the blocks were drawn again) keeps the
    // grid's focus: `apply` gives it to the stop at the cursor. Focus moved anywhere else ends it.
    queueMicrotask(() => {
      if (left.isConnected) focused.current = false;
    });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const at = stopAt(event.target);
    if (!at) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(at);
      return;
    }
    const moved = move(event.key, at, stops.current, rangeDays);
    if (!moved) return;
    event.preventDefault();
    if (moved.outside) {
      // Past the days drawn: only the screen can show another range.
      if (!onNavigate) return;
      cursor.current = moved.cursor;
      onNavigate(moved.cursor.day);
      return;
    }
    cursor.current = moved.cursor;
    apply();
  };

  // A free time chosen with the pointer. Blocks are chosen through the library.
  const onClick = (event: MouseEvent) => {
    const at = stopAt(event.target);
    if (at && at.eventId === undefined) choose(at);
  };

  return (
    // The handlers serve the grid inside, whose cells are the focusable, named elements.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <section
      ref={root}
      aria-label={label}
      className={onSelectSlot ? 'cal cal-bookable rounded-lg border' : 'cal rounded-lg border'}
      style={{ height }}
      onFocus={onFocus}
      onBlur={onBlur}
      onKeyDown={onKeyDown}
      onClick={onClick}
    >
      <BigCalendar<WallEvent>
        localizer={localizer}
        culture={locale}
        events={wallEvents}
        // Controlled: the screen draws its own toolbar and holds the day and the view.
        toolbar={false}
        date={date}
        view={view}
        views={['day', 'week']}
        onNavigate={() => {}}
        onView={() => {}}
        // The hospital's "now", for today's column and the line across it.
        getNow={() => toWall(new Date(), timezone)}
        components={components}
        // Side by side only when two truly overlap: back-to-back appointments stay full width.
        dayLayoutAlgorithm="no-overlap"
        // A block past midnight on each of its days, not in the all-day row, which is hidden.
        showMultiDayTimes
        step={15}
        timeslots={4}
        scrollToTime={scrollToTime}
        // Never the title: a tooltip of a patient name would stay in the page after a hover.
        tooltipAccessor="hint"
        eventPropGetter={(event) => ({ className: TONE_CLASS[event.tone] })}
        onSelectEvent={onSelectEvent ? (event) => onSelectEvent(event.id) : undefined}
        // A day heading of the week opens that day, when the screen offers it.
        drilldownView={onOpenDay ? 'day' : null}
        onDrillDown={onOpenDay ? (wall) => onOpenDay(wallToDay(wall)) : undefined}
        // Nothing is chosen by dragging across empty time (WCAG 2.5.7): a free time is chosen
        // by a click or a key, through the grid's own handlers above.
        selectable={false}
        style={{ height: '100%' }}
      />
    </section>
  );
}

/** The stop of the grid an event happened on, from the attributes `./keyboard` gave it. */
function stopAt(target: EventTarget | null): Cursor | undefined {
  if (!(target instanceof Element)) return undefined;
  const cell = target.closest<HTMLElement>('.rbc-time-content [data-day]');
  if (!cell) return undefined;
  const found = { day: cell.dataset.day ?? '', minutes: Number(cell.dataset.minutes) };
  const eventId = cell.dataset.eventId;
  return eventId === undefined ? found : { ...found, eventId };
}
