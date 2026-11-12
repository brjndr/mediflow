import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEME_TOKENS, contrastRatio, themeFromBrandColor } from '@/shared/lib/theme';

/**
 * The visual language tokens (#707) are CSS derived with color-mix(). jsdom cannot compute them,
 * so this evaluates the few forms the stylesheet uses (oklch literals, var(), black, white and
 * color-mix in oklab) and checks the text contrast that the design promises.
 */
type Lab = [number, number, number];

const css = readFileSync('src/index.css', 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const vars: Record<string, string> = {};
  for (const m of body.matchAll(/^ {2}(--[\w-]+):\s*([^;]*?);\s*$/gms)) {
    if (m[1] && m[2]) vars[m[1]] = m[2].replace(/\s+/g, ' ').trim();
  }
  return vars;
}
const light = block(':root');
const dark = { ...light, ...block('.dark') };

function fromOklch(l: number, c: number, hDeg: number): Lab {
  const h = (hDeg * Math.PI) / 180;
  return [l, c * Math.cos(h), c * Math.sin(h)];
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

function evaluate(expr: string, vars: Record<string, string>): Lab {
  const e = expr.trim();
  if (e === 'black') return [0, 0, 0];
  if (e === 'white') return [1, 0, 0];
  const v = /^var\((--[\w-]+)(?:,\s*(.+))?\)$/s.exec(e.replace(/\s*!important$/, ''));
  if (v?.[1]) return evaluate(vars[v[1]] ?? v[2] ?? '', vars);
  const o = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(e);
  if (o) return fromOklch(Number(o[1]), Number(o[2]), Number(o[3]));
  const mix = /^color-mix\(in oklab,(.*)\)$/s.exec(e);
  if (mix?.[1]) {
    const [a = '', b = ''] = splitArgs(mix[1]);
    const part = (s: string) => {
      const m = /^(.*?)(?:\s+([\d.]+)%)?$/s.exec(s.trim());
      return { color: m?.[1] ?? s, pct: m?.[2] === undefined ? undefined : Number(m[2]) / 100 };
    };
    const pa = part(a);
    const pb = part(b);
    const wa = pa.pct ?? (pb.pct === undefined ? 0.5 : 1 - pb.pct);
    const ca = evaluate(pa.color, vars);
    const cb = evaluate(pb.color, vars);
    return [0, 1, 2].map((i) => ca[i]! * wa + cb[i]! * (1 - wa)) as Lab;
  }
  throw new Error(`cannot evaluate ${e}`);
}

function toHex([L, a, b]: Lab): string {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const hex = lin.map((c) => {
    const x = Math.min(1, Math.max(0, c));
    const g = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    return Math.round(g * 255)
      .toString(16)
      .padStart(2, '0');
  });
  return `#${hex.join('')}`;
}

function fromHex(hex: string): Lab {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

const hexOf = (name: string, vars: Record<string, string>) => toHex(evaluate(`var(${name})`, vars));
const MIN = 4.5;

/** The stylesheet's second gradient stop: 85% primary, 15% of the opposite of the text colour. */
function gradientEnd(primary: Lab, fg: Lab): string {
  const opposite: Lab = [1 - fg[0], 0, 0];
  return toHex([0, 1, 2].map((i) => primary[i]! * 0.85 + opposite[i]! * 0.15) as Lab);
}

describe('visual language tokens', () => {
  it('defines every new token for light and dark, without a raw colour', () => {
    const names = [
      '--info',
      '--page',
      '--elevation-soft',
      '--elevation-raised',
      '--elevation-inset',
      '--brand-gradient',
      ...['success', 'warning', 'destructive', 'info'].flatMap((t) => [
        `--${t}-soft`,
        `--${t}-soft-foreground`,
      ]),
    ];
    for (const n of names) {
      expect(light[n], n).toBeDefined();
      expect(dark[n], n).toBeDefined();
    }
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const visual = bare.slice(bare.indexOf('--info:'), bare.indexOf('@layer base'));
    expect(visual).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(visual).not.toMatch(/\brgba?\(/);
  });

  it('adds no name but the dark counterpart to what a hospital can set', () => {
    expect([...THEME_TOKENS]).toEqual([
      'radius',
      'primary',
      'primary-foreground',
      'ring',
      // The dark counterpart of the brand colour (#729).
      'primary-dark',
      'primary-dark-foreground',
      'accent',
      'accent-foreground',
      'background',
      'foreground',
    ]);
  });

  it.each(['success', 'warning', 'destructive', 'info'])(
    'keeps text readable on the soft %s tone in light and dark',
    (tone) => {
      for (const vars of [light, dark]) {
        const ratio = contrastRatio(
          hexOf(`--${tone}-soft-foreground`, vars),
          hexOf(`--${tone}-soft`, vars),
        );
        expect(ratio).toBeGreaterThanOrEqual(MIN);
      }
    },
  );

  it.each([
    ['the standard teal', '#0f766e'],
    ['a very dark colour', '#0b1020'],
    ['a low-chroma colour', '#5b6470'],
    ['a colour that takes black text', '#757575'],
    ['a deep red', '#9b1c1c'],
  ])('keeps text readable on both gradient stops for %s', (_label, primary) => {
    const theme = themeFromBrandColor(primary);
    expect(theme).not.toBeNull();
    const fg = theme?.['primary-foreground'] ?? '#ffffff';
    expect(contrastRatio(fg, primary)).toBeGreaterThanOrEqual(MIN);
    expect(contrastRatio(fg, gradientEnd(fromHex(primary), fromHex(fg)))).toBeGreaterThanOrEqual(
      MIN,
    );
  });

  it('keeps the default gradient readable in light and dark', () => {
    for (const vars of [light, dark]) {
      const fg = evaluate('var(--primary-foreground)', vars);
      const primary = evaluate('var(--primary)', vars);
      expect(contrastRatio(toHex(fg), toHex(primary))).toBeGreaterThanOrEqual(MIN);
      expect(contrastRatio(toHex(fg), gradientEnd(primary, fg))).toBeGreaterThanOrEqual(MIN);
    }
  });
});
