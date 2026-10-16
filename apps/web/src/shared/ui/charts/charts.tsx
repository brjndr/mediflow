// The chart library lives only in this module. Import charts from './index', which loads this
// file on demand, so the library is never part of the initial bundle or of a route that shows no
// chart.
import { useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';

export interface ChartPoint {
  /** Already formatted for display (a date, a category name). */
  label: string;
  value: number;
}

export interface ChartProps {
  /** Names the chart for assistive technology and heads its data table. */
  title: string;
  /**
   * One line that says what the chart shows ("Busiest on Tuesday, 1,834 visits"). Said with the
   * name; without it, the number of values and the highest and lowest are said.
   */
  summary?: string;
  /** Column headings of the accessible data table, e.g. "Day" and "Appointments". */
  labelHeader: string;
  valueHeader: string;
  data: ChartPoint[];
  /** Formats a value for the axis, the tooltip and the table, e.g. `format.number`. */
  formatValue?: (value: number) => string;
  /** Pixels. The width follows the container. */
  height?: number;
}

// Colours come from the theme tokens, so a chart follows the hospital's brand colour and stays
// legible if the tokens change. Never a hex value here.
const SERIES = 'var(--primary)';
const GRID = 'var(--border)';
const TEXT = 'var(--muted-foreground)';
const SURFACE = 'var(--popover)';

const CHART_MARGIN = { top: 8, right: 12, bottom: 0, left: 0 };
// The drawing is hidden from assistive technology (the data table is the accessible version), so
// it must not be keyboard-focusable either: `accessibilityLayer={false}` on each chart.
const axis = { stroke: GRID, tick: { fill: TEXT, fontSize: 12 }, tickLine: false } as const;
const tooltip = {
  contentStyle: {
    background: SURFACE,
    border: `1px solid ${GRID}`,
    borderRadius: 'var(--radius)',
    color: 'var(--popover-foreground)',
    fontSize: 12,
  },
  cursor: { stroke: GRID, fill: 'var(--accent)' },
} as const;

/** What a chart shows in one line, when the screen does not say: how many, the highest, the lowest. */
function useDefaultSummary(data: ChartPoint[], formatValue: (value: number) => string): string {
  const { t } = useTranslation();
  if (data.length === 0) return t('chart.empty');
  const sorted = [...data].sort((a, b) => b.value - a.value);
  const max = sorted[0]!;
  const min = sorted[sorted.length - 1]!;
  return t('chart.summary', {
    count: data.length,
    maxLabel: max.label,
    max: formatValue(max.value),
    minLabel: min.label,
    min: formatValue(min.value),
  });
}

/**
 * A chart is a picture, which a screen reader cannot read. So the figure is named by its title and
 * a one-line summary, and the same numbers are given as a table: for assistive technology always,
 * and on screen too when someone asks for it ("Show as table"), for anyone who cannot make out the
 * picture or would rather read the numbers than hover over them. The picture itself is hidden from
 * assistive technology and cannot be focused, so its tooltips are never the only way to a value.
 */
function ChartFrame({
  title,
  summary,
  labelHeader,
  valueHeader,
  data,
  formatValue = String,
  height = 240,
  children,
}: ChartProps & { children: ReactNode }) {
  const { t } = useTranslation();
  const [asTable, setAsTable] = useState(false);
  const captionId = useId();
  const fallback = useDefaultSummary(data, formatValue);
  return (
    // Named by its caption in every browser and assistive technology, not only those that do it
    // by themselves.
    <figure aria-labelledby={captionId} className="m-0 flex flex-col gap-2">
      <figcaption id={captionId} className="sr-only">
        {title}. {summary ?? fallback}
      </figcaption>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="self-end"
        aria-pressed={asTable}
        onClick={() => setAsTable((shown) => !shown)}
      >
        {t('chart.showTable')}
      </Button>
      {!asTable && (
        <div aria-hidden style={{ height }}>
          <ResponsiveContainer width="100%" height="100%">
            {children}
          </ResponsiveContainer>
        </div>
      )}
      <div className={cn(asTable ? 'overflow-x-auto rounded-lg border' : 'contents')}>
        <table className={asTable ? 'w-full border-collapse text-sm' : 'sr-only'}>
          <caption className={asTable ? 'sr-only' : undefined}>{title}</caption>
          <thead>
            <tr className={asTable ? 'border-b' : undefined}>
              <th scope="col" className={asTable ? 'px-3 py-2 text-left font-medium' : undefined}>
                {labelHeader}
              </th>
              <th scope="col" className={asTable ? 'px-3 py-2 text-right font-medium' : undefined}>
                {valueHeader}
              </th>
            </tr>
          </thead>
          <tbody>
            {data.map((point) => (
              <tr key={point.label} className={asTable ? 'border-b last:border-0' : undefined}>
                <th scope="row" className={asTable ? 'px-3 py-2 text-left font-normal' : undefined}>
                  {point.label}
                </th>
                <td className={asTable ? 'px-3 py-2 text-right tabular-nums' : undefined}>
                  {formatValue(point.value)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}

/** A value over time or along an ordered axis. */
export function TimeSeriesChart(props: ChartProps) {
  const { data, valueHeader, formatValue } = props;
  return (
    <ChartFrame {...props}>
      <LineChart data={data} margin={CHART_MARGIN} accessibilityLayer={false}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" {...axis} />
        <YAxis {...axis} axisLine={false} tickFormatter={formatValue} width={48} />
        <Tooltip {...tooltip} formatter={(value) => formatValue?.(Number(value)) ?? value} />
        <Line
          type="monotone"
          dataKey="value"
          name={valueHeader}
          stroke={SERIES}
          strokeWidth={2}
          dot={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartFrame>
  );
}

/** Values compared across categories. */
export function CategoryBarChart(props: ChartProps) {
  const { data, valueHeader, formatValue } = props;
  return (
    <ChartFrame {...props}>
      <BarChart data={data} margin={CHART_MARGIN} accessibilityLayer={false}>
        <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="label" {...axis} />
        <YAxis {...axis} axisLine={false} tickFormatter={formatValue} width={48} />
        <Tooltip {...tooltip} formatter={(value) => formatValue?.(Number(value)) ?? value} />
        <Bar
          dataKey="value"
          name={valueHeader}
          fill={SERIES}
          radius={[4, 4, 0, 0]}
          isAnimationActive={false}
        />
      </BarChart>
    </ChartFrame>
  );
}
