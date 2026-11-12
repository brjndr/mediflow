import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Card } from './card';

interface StatCardProps {
  /** Id for the heading, unique on the page. */
  id: string;
  title: string;
  /** Where the full screen is; the card is a link when given. */
  to?: string;
  linkLabel?: string;
  children: ReactNode;
}

/** A dashboard widget's frame: a titled section with an optional link to the full screen. */
export function StatCard({ id, title, to, linkLabel, children }: StatCardProps) {
  return (
    <Card asChild>
      <section aria-labelledby={id} className="flex flex-col gap-2">
        <h2 id={id} className="text-sm font-medium">
          {title}
        </h2>
        {children}
        {to && linkLabel && (
          <Link
            to={to}
            className="mt-auto inline-flex text-sm text-primary underline-offset-4 hover:underline pointer-coarse:min-h-11 pointer-coarse:items-center"
          >
            {linkLabel}
          </Link>
        )}
      </section>
    </Card>
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
      <strong className="text-2xl font-semibold tabular-nums">
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
