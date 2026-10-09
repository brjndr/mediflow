// The chart library lives only in this module. Import charts from './index', which loads this
// file on demand, so the library is never part of the initial bundle or of a route that shows no
// chart.
import type { ReactNode } from 'react';
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

export interface ChartPoint {
  /** Already formatted for display (a date, a category name). */
  label: string;
  value: number;
}

export interface ChartProps {
  /** Names the chart for assistive technology and heads its data table. */
  title: string;
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

/**
 * A chart is a picture, which a screen reader cannot read. The same numbers are therefore also
 * given as a table that only assistive technology sees, and the picture itself is hidden from it.
 */
function ChartFrame({
  title,
  labelHeader,
  valueHeader,
  data,
  formatValue = String,
  height = 240,
  children,
}: ChartProps & { children: ReactNode }) {
  return (
    <figure className="m-0">
      <div aria-hidden style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">{labelHeader}</th>
            <th scope="col">{valueHeader}</th>
          </tr>
        </thead>
        <tbody>
          {data.map((point) => (
            <tr key={point.label}>
              <th scope="row">{point.label}</th>
              <td>{formatValue(point.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
