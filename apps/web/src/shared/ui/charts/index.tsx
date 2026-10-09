// Charts load on demand. These wrappers are what screens import: they pull in the chart library
// only when a chart is actually rendered, and show a placeholder of the same height meanwhile.
import { lazy, Suspense } from 'react';
import { Skeleton } from '@/shared/ui/skeleton';
import type { ChartProps } from './charts';

export type { ChartPoint, ChartProps } from './charts';

const LazyTimeSeries = lazy(() =>
  import('./charts').then((module) => ({ default: module.TimeSeriesChart })),
);
const LazyCategoryBar = lazy(() =>
  import('./charts').then((module) => ({ default: module.CategoryBarChart })),
);

function Placeholder({ height = 240 }: { height?: number }) {
  return <Skeleton style={{ height }} className="w-full" />;
}

/** A value over time or along an ordered axis. */
export function TimeSeriesChart(props: ChartProps) {
  return (
    <Suspense fallback={<Placeholder height={props.height} />}>
      <LazyTimeSeries {...props} />
    </Suspense>
  );
}

/** Values compared across categories. */
export function CategoryBarChart(props: ChartProps) {
  return (
    <Suspense fallback={<Placeholder height={props.height} />}>
      <LazyCategoryBar {...props} />
    </Suspense>
  );
}
