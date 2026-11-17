/**
 * A small PDF writer for the consents and certificates kept as documents (#990): A4 pages of
 * wrapped text, headings, label and value rows and a drawn signature, in the two standard
 * Helvetica fonts, so nothing is embedded and no dependency is added. The standard fonts hold the
 * Latin-1 range only: any other character is drawn as `?` until a font is embedded (see the
 * feature's CLAUDE.md).
 */
export type Block =
  | { kind: 'title'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'row'; label: string; value: string }
  | { kind: 'signature'; path: string }
  | { kind: 'space' };

const PAGE_WIDTH = 595;
const PAGE_HEIGHT = 842;
const MARGIN = 56;
const WIDTH = PAGE_WIDTH - MARGIN * 2;
const LABEL_WIDTH = 150;
// Helvetica's average advance is about half the size; a capital letter is wider, so wrapping
// assumes a little more than that and a line never runs past the margin.
const ADVANCE = 0.56;

/** One character as the standard fonts have it: Latin-1, or `?`. */
const latin = (text: string) =>
  [...text]
    .map((c) => (c === '\n' ? c : c < ' ' ? ' ' : c.charCodeAt(0) > 0xff ? '?' : c))
    .join('');
const escape = (text: string) => latin(text).replace(/[\\()]/g, (c) => `\\${c}`);

function wrap(text: string, size: number, width: number): string[] {
  const max = Math.max(1, Math.floor(width / (size * ADVANCE)));
  const lines: string[] = [];
  for (const paragraph of latin(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(' ')) {
      let rest = word;
      while (rest.length > max) {
        if (line) {
          lines.push(line);
          line = '';
        }
        lines.push(rest.slice(0, max));
        rest = rest.slice(max);
      }
      const next = line ? `${line} ${rest}` : rest;
      if (next.length > max) {
        lines.push(line);
        line = rest;
      } else line = next;
    }
    lines.push(line);
  }
  return lines;
}

/** The numbers of drawn-signature path data (`M x y L x y`), as strokes in a 300 by 150 box. */
function strokes(path: string): { x: number; y: number; move: boolean }[] {
  const tokens = path.match(/[ML]|-?\d*\.?\d+/g) ?? [];
  const points: { x: number; y: number; move: boolean }[] = [];
  let move = true;
  for (let i = 0; i < tokens.length;) {
    const token = tokens[i]!;
    if (token === 'M' || token === 'L') {
      move = token === 'M';
      i += 1;
      continue;
    }
    const x = Number(token);
    const y = Number(tokens[i + 1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) break;
    points.push({ x, y, move });
    move = false;
    i += 2;
  }
  return points;
}

export function renderPdf(title: string, blocks: Block[]): Buffer {
  const pages: string[][] = [[]];
  let y = PAGE_HEIGHT - MARGIN;
  const put = (command: string) => pages[pages.length - 1]!.push(command);
  const room = (height: number) => {
    if (y - height < MARGIN) {
      pages.push([]);
      y = PAGE_HEIGHT - MARGIN;
    }
  };
  const write = (font: 'F1' | 'F2', size: number, x: number, text: string) =>
    put(`BT /${font} ${size} Tf ${x} ${y} Td (${escape(text)}) Tj ET`);

  for (const block of blocks) {
    if (block.kind === 'space') {
      y -= 10;
    } else if (block.kind === 'title' || block.kind === 'heading' || block.kind === 'text') {
      const size = block.kind === 'title' ? 18 : block.kind === 'heading' ? 12 : 10.5;
      const font = block.kind === 'text' ? 'F1' : 'F2';
      const lead = size * 1.4;
      if (block.kind !== 'text') y -= 4;
      for (const line of wrap(block.text, size, WIDTH)) {
        room(lead);
        y -= lead;
        if (line) write(font, size, MARGIN, line);
      }
    } else if (block.kind === 'row') {
      const label = wrap(block.label, 10.5, LABEL_WIDTH - 8);
      const value = wrap(block.value, 10.5, WIDTH - LABEL_WIDTH);
      const count = Math.max(label.length, value.length);
      for (let i = 0; i < count; i += 1) {
        room(15);
        y -= 15;
        if (label[i]) write('F2', 10.5, MARGIN, label[i]!);
        if (value[i]) write('F1', 10.5, MARGIN + LABEL_WIDTH, value[i]!);
      }
    } else {
      const points = strokes(block.path);
      room(90);
      const top = y;
      put(`0.7 g ${MARGIN} ${top - 80} 160 80 re S 0 g`);
      for (const p of points) {
        const px = MARGIN + 5 + (Math.min(300, Math.max(0, p.x)) / 300) * 150;
        const py = top - 5 - (Math.min(150, Math.max(0, p.y)) / 150) * 70;
        put(`${px.toFixed(2)} ${py.toFixed(2)} ${p.move ? 'm' : 'l'}`);
      }
      if (points.length > 1) put('S');
      y = top - 86;
    }
  }

  // Objects: 1 catalog, 2 pages, 3 and 4 fonts, then a page and its content for each page.
  const bodies: string[] = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  bodies[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  bodies[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  bodies[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  bodies[4] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  pages.forEach((commands, i) => {
    const stream = commands.join('\n');
    bodies[5 + i * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`;
    bodies[6 + i * 2] =
      `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`;
  });
  const info = bodies.length;
  bodies[info] = `<< /Title (${escape(title)}) /Producer (Mediflow) >>`;

  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offsets: number[] = [];
  let size = parts[0]!.length;
  for (let id = 1; id < bodies.length; id += 1) {
    offsets[id] = size;
    const part = Buffer.from(`${id} 0 obj\n${bodies[id]}\nendobj\n`, 'latin1');
    parts.push(part);
    size += part.length;
  }
  const xref = [`xref\n0 ${bodies.length}\n0000000000 65535 f \n`];
  for (let id = 1; id < bodies.length; id += 1) {
    xref.push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }
  xref.push(
    `trailer\n<< /Size ${bodies.length} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${size}\n%%EOF\n`,
  );
  parts.push(Buffer.from(xref.join(''), 'latin1'));
  return Buffer.concat(parts);
}
