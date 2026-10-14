// The calendar loads on demand. This is what screens import: it pulls in the calendar library
// (react-big-calendar, MIT) only when a calendar is rendered, and shows a placeholder of the same
// height meanwhile. Screens never import the library itself.
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
  /** Added to the block's tooltip and accessible name, never in place of the title. */
  hint?: string;
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
