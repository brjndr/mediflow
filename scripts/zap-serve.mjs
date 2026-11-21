// Serves the built web app as the static host would, for the ZAP scan (#1082): the files of
// apps/web/dist with the headers of apps/web/public/_headers, index.html for any route the files do
// not hold, and /api/* proxied to the API (the one origin of production). `vite preview` sends none
// of the host's headers, so a scan of it would report what production does not do.
//
//   node scripts/zap-serve.mjs [port=8080] [api=http://localhost:3000]
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headersFor, parseHeadersFile } from './zap-serve-lib.mjs';

const port = Number(process.argv[2] ?? 8080);
const api = new URL(process.argv[3] ?? 'http://localhost:3000');
const root = fileURLToPath(new URL('../apps/web/dist/', import.meta.url));
const rules = parseHeadersFile(readFileSync(join(root, '_headers'), 'utf8'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

function fileFor(path) {
  const candidate = normalize(join(root, decodeURIComponent(path)));
  if (!candidate.startsWith(root) && `${candidate}${sep}` !== root) return undefined;
  try {
    return statSync(candidate).isFile() ? candidate : undefined;
  } catch {
    return undefined;
  }
}

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    const upstream = httpRequest(
      {
        host: api.hostname,
        port: api.port,
        method: req.method,
        path: url.pathname.slice(4) + url.search || '/',
        headers: { ...req.headers, host: api.host },
      },
      (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.writeHead(502).end();
    });
    req.pipe(upstream);
    return;
  }
  const file = fileFor(url.pathname) ?? join(root, 'index.html');
  res.writeHead(200, {
    ...headersFor(rules, url.pathname),
    'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
  });
  createReadStream(file).pipe(res);
}).listen(port, () => {
  process.stdout.write(
    `serving apps/web/dist on http://localhost:${port}, /api -> ${api.origin}\n`,
  );
});
