import { useEffect, useRef, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { PAD_HEIGHT, PAD_WIDTH, SIGNATURE_MAX } from '../schemas';

/** A point in the pad's own box, to one decimal. */
const point = (event: PointerEvent<SVGSVGElement>) => {
  const box = event.currentTarget.getBoundingClientRect();
  const x = ((event.clientX - box.left) / (box.width || PAD_WIDTH)) * PAD_WIDTH;
  const y = ((event.clientY - box.top) / (box.height || PAD_HEIGHT)) * PAD_HEIGHT;
  const clamp = (value: number, max: number) =>
    Math.round(Math.min(Math.max(value, 0), max) * 10) / 10;
  return `${clamp(x, PAD_WIDTH)} ${clamp(y, PAD_HEIGHT)}`;
};

/**
 * Where a person signs with a finger, a stylus or a mouse. What is drawn is kept as SVG path data
 * (`M x y L x y ...` in a 300 by 150 box), not as an image: it is small, it is drawn again at any
 * size, and it holds nothing but numbers. The pad is no way in for someone who cannot draw: the
 * form offers a typed signature beside it. Drawing stops at the API's size limit.
 */
export function SignaturePad({
  path,
  onChange,
  disabled,
}: {
  path: string;
  onChange: (path: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation('consents');
  const drawing = useRef(false);
  // The drawn path is read from a ref, since pointer events can arrive faster than renders.
  const latest = useRef(path);
  // The parent clears or sets it: the ref follows what is drawn.
  useEffect(() => {
    latest.current = path;
  }, [path]);

  const extend = (add: string) => {
    const next = latest.current + add;
    if (next.length > SIGNATURE_MAX) return;
    latest.current = next;
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-2">
      <svg
        role="img"
        aria-label={path ? t('signature.padSigned') : t('signature.padEmpty')}
        viewBox={`0 0 ${PAD_WIDTH} ${PAD_HEIGHT}`}
        className="h-auto w-full max-w-md touch-none rounded-md border bg-background text-foreground"
        style={{ aspectRatio: `${PAD_WIDTH} / ${PAD_HEIGHT}`, touchAction: 'none' }}
        onPointerDown={(event) => {
          if (disabled) return;
          drawing.current = true;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          extend(`${latest.current ? ' ' : ''}M ${point(event)}`);
        }}
        onPointerMove={(event) => {
          if (drawing.current) extend(` L ${point(event)}`);
        }}
        onPointerUp={() => {
          drawing.current = false;
        }}
        onPointerCancel={() => {
          drawing.current = false;
        }}
      >
        <line
          x1="10"
          x2={PAD_WIDTH - 10}
          y1={PAD_HEIGHT - 30}
          y2={PAD_HEIGHT - 30}
          stroke="currentColor"
          strokeOpacity="0.3"
          strokeDasharray="4 4"
        />
        <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
    </div>
  );
}

/** A saved signature, drawn from its path data. */
export function SignatureView({ path, label }: { path: string; label: string }) {
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${PAD_WIDTH} ${PAD_HEIGHT}`}
      className="h-auto w-full max-w-xs rounded-md border bg-background text-foreground"
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
