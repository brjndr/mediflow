// The calendar library and its styles. Loaded on demand through `./index`, in its own chunk
// (`calendar`, which may use the heavy budget): never part of the initial load.
import { useLayoutEffect, useMemo, useRef, type SyntheticEvent } from 'react';
import {
  Calendar as BigCalendar,
  DateLocalizer,
  type Components,
  type EventProps,
  type Formats,
} from 'react-big-calendar';
import 'react-big-calendar/lib/css/react-big-calendar.css';
import './calendar.css';
import type { CalendarEventItem, CalendarProps } from './index';
import { dayToWall, toWall, wallToDay, weekStartFor } from './zoned';

interface WallEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  tone: NonNullable<CalendarEventItem['tone']>;
  hint?: string;
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
 * is not there. Those roles are removed: the headings are read as text, and each appointment is
 * a button with its time and title.
 */
const BROKEN_ROLES = '[role="columnheader"], [role="row"], [role="rowgroup"]';

/**
 * What a block says, on one line so a fifteen-minute block of a week column can hold it: the
 * start and the title, with the end for assistive technology. The library's own two-line label
 * is hidden by `calendar.css`.
 */
function eventContent(time: Intl.DateTimeFormat): Components<WallEvent>['event'] {
  return function EventContent({ event }: EventProps<WallEvent>) {
    return (
      <span className="cal-event-line">
        <span className="font-medium">{time.format(event.start)}</span>
        <span className="sr-only"> – {time.format(event.end)}</span> {event.title}
      </span>
    );
  };
}

/** Where the day opens when nothing is booked: the start of a usual working day. */
const OPENING_HOUR = 8;

// Default export: loaded with React.lazy by `./index`.
export default function CalendarImpl({
  label,
  view,
  day,
  timezone,
  locale,
  events,
  onSelectEvent,
  onOpenDay,
  height = 640,
}: CalendarProps) {
  const localizer = useMemo(() => intlLocalizer(locale), [locale]);
  // Stable, so the library does not remount every block on each render.
  const components = useMemo<Components<WallEvent>>(
    () => ({ event: eventContent(makeFormat(locale, { timeStyle: 'short' })) }),
    [locale],
  );
  const root = useRef<HTMLElement>(null);

  // After every render, since the library draws new headings for another day or view.
  useLayoutEffect(() => {
    root.current?.querySelectorAll(BROKEN_ROLES).forEach((element) => {
      element.removeAttribute('role');
      element.removeAttribute('aria-sort');
    });
  });

  const wallEvents = useMemo<WallEvent[]>(
    () =>
      events.map((event) => ({
        id: event.id,
        title: event.title,
        start: toWall(event.start, timezone),
        end: toWall(event.end, timezone),
        tone: event.tone ?? 'primary',
        hint: event.hint,
      })),
    [events, timezone],
  );

  // Open the day at its first event, or at the start of a working day when it has none.
  const scrollToTime = useMemo(() => {
    const earliest = wallEvents.reduce<Date | undefined>(
      (first, event) =>
        first === undefined ||
        event.start.getHours() * 60 + event.start.getMinutes() <
          first.getHours() * 60 + first.getMinutes()
          ? event.start
          : first,
      undefined,
    );
    const opening = dayToWall(day);
    opening.setHours(earliest ? earliest.getHours() : OPENING_HOUR, 0, 0, 0);
    return opening;
  }, [wallEvents, day]);

  const date = useMemo(() => dayToWall(day), [day]);

  const onKey = (event: WallEvent, key: SyntheticEvent) => {
    const pressed = (key.nativeEvent as globalThis.KeyboardEvent).key;
    if (pressed === 'Enter' || pressed === ' ') {
      key.preventDefault();
      onSelectEvent?.(event.id);
    }
  };

  return (
    <section ref={root} aria-label={label} className="cal rounded-lg border" style={{ height }}>
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
        step={15}
        timeslots={4}
        scrollToTime={scrollToTime}
        tooltipAccessor={(event) => event.hint ?? event.title}
        eventPropGetter={(event) => ({ className: TONE_CLASS[event.tone] })}
        onSelectEvent={onSelectEvent ? (event) => onSelectEvent(event.id) : undefined}
        onKeyPressEvent={onSelectEvent ? onKey : undefined}
        // A day heading of the week opens that day, when the screen offers it.
        drilldownView={onOpenDay ? 'day' : null}
        onDrillDown={onOpenDay ? (wall) => onOpenDay(wallToDay(wall)) : undefined}
        // Nothing is chosen by dragging across empty time: booking has its own screen.
        selectable={false}
        style={{ height: '100%' }}
      />
    </section>
  );
}
