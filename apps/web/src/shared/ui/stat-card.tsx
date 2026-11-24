import type { LucideIcon } from 'lucide-react';
import { MoveRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { cn } from '@/shared/lib/utils';
import { Card } from './card';

/** One of the five accent hues derived from the brand colour (#1119). */
export type Accent = 1 | 2 | 3 | 4 | 5;

const CHIP: Record<Accent, string> = {
  1: 'bg-accent-1-soft text-accent-1',
  2: 'bg-accent-2-soft text-accent-2',
  3: 'bg-accent-3-soft text-accent-3',
  4: 'bg-accent-4-soft text-accent-4',
  5: 'bg-accent-5-soft text-accent-5',
};

/**
 * A widget's heading, with its icon on a chip of an accent hue when given. The icon is
 * decorative; the heading's words name the widget.
 */
export function WidgetHeading({
  id,
  title,
  icon: Icon,
  accent = 1,
}: {
  id: string;
  title: string;
  icon?: LucideIcon;
  accent?: Accent;
}) {
  return (
    <h2 id={id} className="flex items-center gap-2.5 text-sm font-semibold">
      {Icon && (
        <span
          aria-hidden
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-lg',
            CHIP[accent],
          )}
        >
          <Icon className="size-4" />
        </span>
      )}
      {title}
    </h2>
  );
}

interface StatCardProps {
  /** Id for the heading, unique on the page. */
  id: string;
  title: string;
  /** An icon for the heading, drawn on a chip of the `accent` hue. */
  icon?: LucideIcon;
  accent?: Accent;
  /** Where the full screen is; the card is a link when given. */
  to?: string;
  linkLabel?: string;
  children: ReactNode;
}

/** A dashboard widget's frame: a titled section with an optional link to the full screen. */
export function StatCard({ id, title, icon, accent, to, linkLabel, children }: StatCardProps) {
  return (
    <Card asChild>
      <section aria-labelledby={id} className="flex flex-col gap-2">
        <WidgetHeading id={id} title={title} icon={icon} accent={accent} />
        {children}
        {to && linkLabel && <WidgetLink to={to}>{linkLabel}</WidgetLink>}
      </section>
    </Card>
  );
}

/** The link at the foot of a widget to its full screen: a tinted pill with an arrow. */
export function WidgetLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="mt-auto inline-flex min-h-8 w-fit items-center gap-1.5 rounded-full border border-primary/30 bg-primary-soft px-3 text-sm font-semibold text-primary-ink shadow-tinted outline-none transition-[background-color,transform] hover:-translate-y-px focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11"
    >
      {children}
      <MoveRight aria-hidden className="size-4" />
    </Link>
  );
}

/** One figure with its label: a count that is not yet known shows a dash. */
export function Stat({
  label,
  value,
  unknown,
}: {
  label: string;
  value: number | undefined;
  /** Said in place of the dash while the figure is not known. */
  unknown: string;
}) {
  return (
    <p className="flex items-baseline justify-between gap-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <strong className="font-display text-2xl font-semibold tabular-nums md:text-3xl">
        {value ?? (
          <>
            <span aria-hidden>–</span>
            <span className="sr-only">{unknown}</span>
          </>
        )}
      </strong>
    </p>
  );
}
