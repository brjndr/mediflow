// Measures a built SPA against the bundle budgets in CLAUDE.md (Performance Strategy).
// No dependencies: Node's own zlib and fs. Sizes are gzipped bytes.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

// 1 kB = 1000 bytes, as Vite reports it, so these numbers match the build output.
const KB = 1000;

/** Budgets in gzipped kB. */
export const DEFAULT_BUDGETS = {
  /** Everything the browser must load before first render: the entry and its static imports. */
  initialJsKb: 300,
  /** Any chunk loaded on demand (a route, a widget, a locale file). */
  lazyChunkKb: 150,
  /** Lazy chunks allowed to be heavier because they carry one big library. */
  heavyChunkKb: 250,
  /** All CSS together. */
  cssKb: 60,
  /** A PR that grows a chunk by more than this must say why. Reported, not failed. */
  growthWarningKb: 30,
};

/** Chunk names (without hash) that may use the heavy budget. Add one only with a stated reason. */
export const HEAVY_CHUNKS = ['calendar', 'charts', 'editor', 'pdf'];

/** `assets/index-C2l-WN8R.js` -> `index.js`. The hash changes every build; the name is stable. */
export function stableName(file) {
  const base = file.split('/').pop() ?? file;
  return base.replace(/-[A-Za-z0-9_-]{8}(\.[a-z]+)$/, '$1');
}

/**
 * Reads a dist folder and returns every JS and CSS asset with its gzipped size, marking the JS
 * that index.html loads up front (the module script and its modulepreload links) as initial.
 */
export function measure(distDir) {
  const html = readFileSync(join(distDir, 'index.html'), 'utf8');
  const initial = new Set(
    [...html.matchAll(/<(?:script|link)\b[^>]*?(?:src|href)="\/?(assets\/[^"]+\.js)"/g)].map(
      (match) => match[1],
    ),
  );
  const assetsDir = join(distDir, 'assets');
  const assets = readdirSync(assetsDir)
    .filter((file) => /\.(js|css)$/.test(file))
    .map((file) => {
      const path = `assets/${file}`;
      const type = file.endsWith('.css') ? 'css' : 'js';
      return {
        name: stableName(file),
        file: path,
        type,
        initial: type === 'js' && initial.has(path),
        gzipBytes: gzipSync(readFileSync(join(assetsDir, file))).length,
      };
    })
    .sort((a, b) => b.gzipBytes - a.gzipBytes);
  if (initial.size === 0 || !assets.some((asset) => asset.initial)) {
    throw new Error(`No initial JavaScript found in ${join(distDir, 'index.html')}`);
  }
  return assets;
}

const sum = (assets) => assets.reduce((total, asset) => total + asset.gzipBytes, 0);
const kb = (bytes) => bytes / KB;

/** Compares measured assets with the budgets. `violations` is empty when everything fits. */
export function check(assets, budgets = DEFAULT_BUDGETS, heavy = HEAVY_CHUNKS) {
  const initialBytes = sum(assets.filter((asset) => asset.initial));
  const cssBytes = sum(assets.filter((asset) => asset.type === 'css'));
  const violations = [];

  if (kb(initialBytes) > budgets.initialJsKb) {
    violations.push(
      `Initial JS is ${kb(initialBytes).toFixed(1)} kB gzipped (budget ${budgets.initialJsKb} kB).`,
    );
  }
  if (kb(cssBytes) > budgets.cssKb) {
    violations.push(`CSS is ${kb(cssBytes).toFixed(1)} kB gzipped (budget ${budgets.cssKb} kB).`);
  }
  for (const asset of assets) {
    if (asset.type !== 'js' || asset.initial) continue;
    const isHeavy = heavy.some((prefix) => asset.name.startsWith(prefix));
    const limit = isHeavy ? budgets.heavyChunkKb : budgets.lazyChunkKb;
    if (kb(asset.gzipBytes) > limit) {
      violations.push(
        `Lazy chunk ${asset.name} is ${kb(asset.gzipBytes).toFixed(1)} kB gzipped (budget ${limit} kB${isHeavy ? ', heavy' : ''}).`,
      );
    }
  }
  return { initialBytes, cssBytes, violations };
}

/** Sizes keyed by stable name. Chunks that share a name are added together. */
function byName(assets) {
  const sizes = new Map();
  for (const asset of assets) sizes.set(asset.name, (sizes.get(asset.name) ?? 0) + asset.gzipBytes);
  return sizes;
}

/**
 * Size change per chunk between a baseline build (the PR's base branch) and this one.
 * `warnings` lists chunks that grew past the threshold and therefore need a reason in the PR.
 */
export function compare(assets, baseline, budgets = DEFAULT_BUDGETS) {
  const now = byName(assets);
  const before = byName(baseline);
  const rows = [...new Set([...now.keys(), ...before.keys()])]
    .map((name) => {
      const current = now.get(name);
      const previous = before.get(name);
      return { name, current, previous, delta: (current ?? 0) - (previous ?? 0) };
    })
    .filter((row) => row.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const warnings = rows
    .filter((row) => kb(row.delta) > budgets.growthWarningKb)
    .map(
      (row) =>
        `${row.name} grew by ${kb(row.delta).toFixed(1)} kB gzipped (more than ${budgets.growthWarningKb} kB): say why in the PR.`,
    );
  return { rows, warnings };
}

const cell = (bytes) => (bytes === undefined ? '-' : `${kb(bytes).toFixed(2)} kB`);
const signed = (bytes) => `${bytes > 0 ? '+' : ''}${kb(bytes).toFixed(2)} kB`;

/** The report as Markdown, for the terminal and the CI job summary. */
export function toMarkdown({ assets, result, budgets = DEFAULT_BUDGETS, comparison, baseline }) {
  const lines = ['## Bundle size', ''];
  const status = (ok) => (ok ? 'ok' : 'OVER');
  const baseInitial = baseline && sum(baseline.filter((asset) => asset.initial));
  const baseCss = baseline && sum(baseline.filter((asset) => asset.type === 'css'));
  const change = (now, base) => (base === undefined ? '' : ` | ${signed(now - base)}`);

  lines.push(
    `| Budget | Size (gzip) | Limit | Status${baseline ? ' | Change' : ''} |`,
    `|---|---|---|---${baseline ? '|---' : ''}|`,
    `| Initial JS | ${cell(result.initialBytes)} | ${budgets.initialJsKb} kB | ${status(kb(result.initialBytes) <= budgets.initialJsKb)}${change(result.initialBytes, baseInitial)} |`,
    `| CSS | ${cell(result.cssBytes)} | ${budgets.cssKb} kB | ${status(kb(result.cssBytes) <= budgets.cssKb)}${change(result.cssBytes, baseCss)} |`,
    '',
    '| Chunk | Loaded | Size (gzip) |',
    '|---|---|---|',
    ...assets.map(
      (asset) =>
        `| ${asset.name} | ${asset.type === 'css' ? 'css' : asset.initial ? 'initial' : 'lazy'} | ${cell(asset.gzipBytes)} |`,
    ),
  );

  if (comparison) {
    lines.push('', '### Change against the base branch', '');
    if (comparison.rows.length === 0) {
      lines.push('No chunk changed size.');
    } else {
      lines.push(
        '| Chunk | Before | After | Change |',
        '|---|---|---|---|',
        ...comparison.rows.map(
          (row) =>
            `| ${row.name} | ${cell(row.previous)} | ${cell(row.current)} | ${signed(row.delta)} |`,
        ),
      );
    }
    for (const warning of comparison.warnings) lines.push('', `**Needs a reason:** ${warning}`);
  }

  if (result.violations.length > 0) {
    lines.push('', '### Over budget', '', ...result.violations.map((v) => `- ${v}`));
  }
  return `${lines.join('\n')}\n`;
}
