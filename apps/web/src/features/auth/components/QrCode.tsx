import QRCode from 'qrcode';
import { useMemo } from 'react';

/**
 * Draws a QR code as SVG from the code's own modules, so nothing is injected as markup and no
 * image address carries the secret. Default export: it loads on demand, with the `qrcode` library,
 * only on the screen that sets up an authenticator.
 */
export default function QrCode({ value, label }: { value: string; label: string }) {
  const { size, path } = useMemo(() => {
    const { modules } = QRCode.create(value, { errorCorrectionLevel: 'M' });
    let d = '';
    for (let row = 0; row < modules.size; row++) {
      for (let col = 0; col < modules.size; col++) {
        if (modules.get(row, col)) d += `M${col} ${row}h1v1h-1z`;
      }
    }
    return { size: modules.size, path: d };
  }, [value]);

  const quiet = 2;
  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`${-quiet} ${-quiet} ${size + quiet * 2} ${size + quiet * 2}`}
      className="size-48 rounded-md border bg-white"
      shapeRendering="crispEdges"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
