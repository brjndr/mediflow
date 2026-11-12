import { cn } from '@/shared/lib/utils';
import type { StatusTone } from './status-badge';

const STROKES: Record<StatusTone, string> = {
  success: 'stroke-success',
  warning: 'stroke-warning',
  danger: 'stroke-destructive',
  info: 'stroke-info',
  neutral: 'stroke-primary',
};

interface RingGaugeProps {
  /** Share of the whole, 0 to 100; anything outside is clamped. */
  value: number;
  /** Already translated: what the figure measures, said with the value. */
  label: string;
  tone?: StatusTone;
  /** Side in px. */
  size?: number;
  className?: string;
}

const STROKE_WIDTH = 8;
const RADIUS = (100 - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** An SVG ring with the value written in its middle, on a raised disc. */
export function RingGauge({
  value,
  label,
  tone = 'neutral',
  size = 96,
  className,
}: RingGaugeProps) {
  const pct = Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 0;
  return (
    <div
      role="img"
      aria-label={`${label}: ${pct}%`}
      className={cn('relative inline-flex rounded-full bg-card shadow-raised', className)}
      style={{ width: size, height: size }}
    >
      <svg viewBox="0 0 100 100" aria-hidden="true" className="size-full -rotate-90">
        <circle
          cx="50"
          cy="50"
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE_WIDTH}
          className="stroke-muted"
        />
        <circle
          cx="50"
          cy="50"
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={CIRCUMFERENCE * (1 - pct / 100)}
          className={STROKES[tone]}
        />
      </svg>
      <span
        aria-hidden="true"
        className="absolute inset-0 flex items-center justify-center text-lg font-semibold tabular-nums"
      >
        {pct}%
      </span>
    </div>
  );
}
