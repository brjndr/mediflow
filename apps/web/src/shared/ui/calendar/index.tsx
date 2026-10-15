// The calendar loads on demand. This is what screens import: it pulls in the calendar library
// (react-big-calendar, MIT) only when a calendar is rendered, and shows a placeholder of the same
// height meanwhile. Screens never import the library itself.
import type { LucideIcon } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { Skeleton } from '@/shared/ui/skeleton';
import type { DayString } from '@/shared/utils/timezone';
import type { CalendarView } from './zoned';

// The range and week helpers are in `./zoned`, imported from there: this file exports components.
export type { CalendarView } from './zoned';

/** One block on the calendar. Instants, as stored: the calendar shows them at the hospital. */
export interface CalendarEventItem {
  id: string;
  /** What the block says, after its time. Never used as a tooltip: see `hint`. */
  title: string;
  /** UTC ISO strings. */
  start: string;
  end: string;
  /** How it is drawn: `struck` for something that will not happen, `danger` for a problem. */
  tone?: 'primary' | 'muted' | 'struck' | 'danger';
  /** Added to the block's tooltip, never in place of the title. */
  hint?: string;
  /**
   * What assistive technology hears after the time and the day, in place of the title: the
   * block's full meaning (who, with whom, the status), where the title is cut short to fit.
   */
  label?: string;
  /**
   * Drawn before the time, hidden from assistive technology (the label says it): a sign that
   * does not rely on colour, such as a status, at the start where truncation cannot cut it off.
   */
  icon?: LucideIcon;
}

export interface CalendarProps {
  /** The accessible name of the calendar. */
  label: string;
  /** Day or week. The week view is for desktop width (CLAUDE.md, Responsive Design). */
  view: CalendarView;
  /** The day shown, or a day of the week shown, as a calendar day at the hospital. */
  day: DayString;
  /** The hospital's timezone and locale, from the tenant config. */
  timezone: string;
  locale: string;
  /** Only those of the days shown: the screen asks the server for the visible range alone. */
  events: CalendarEventItem[];
  /** A block chosen by click, tap, Enter or Space. */
  onSelectEvent?: (id: string) => void;
  /**
   * A time with nothing booked chosen by click, tap, Enter or Space: the day and its start as
   * `HH:mm` at the hospital. Without it a free time can be reached but does nothing.
   */
  onSelectSlot?: (day: DayString, time: string) => void;
  /**
   * Which free times can be chosen (a time in the past, or a day outside a booking window, may
   * not), as the day and `HH:mm` at the hospital. All of them when absent.
   */
  canSelectSlot?: (day: DayString, time: string) => boolean;
  /** What choosing a free time does, said after its name of each that can be chosen. */
  slotAction?: string;
  /**
   * The blocks of the days shown are still loading: the grid is marked busy, and no free time
   * can be chosen, since every time would look free.
   */
  busy?: boolean;
  /**
   * The keyboard moved past the days shown (an arrow at the edge, Page Up or Page Down): show
   * the range that holds this day. Without it the keyboard stays within the days shown.
   */
  onNavigate?: (day: DayString) => void;
  /** A day heading of the week chosen, to show that day. */
  onOpenDay?: (day: DayString) => void;
  /** In pixels, or a CSS length such as `min(640px, 70dvh)`. The hours scroll inside it. */
  height?: number | string;
}

const LazyCalendar = lazy(() => import('./calendar'));

/** A day or week time grid of events, in the hospital's timezone. */
export function Calendar(props: CalendarProps) {
  const height = props.height ?? 640;
  return (
    <Suspense fallback={<Skeleton style={{ height }} className="w-full" />}>
      <LazyCalendar {...props} />
    </Suspense>
  );
}
