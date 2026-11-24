import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig, type PluginOption } from 'vite';

const analyze = process.env.ANALYZE === 'true';

// Only stable vendor libraries go in the long-cached vendor chunk (CLAUDE.md Performance > Build).
const VENDOR =
  /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|cookie|set-cookie-parser|@tanstack[\\/](react-query|query-core))[\\/]/;

// The home page's tiles: each widget is its own lazy import, which cost a request apiece plus the
// small modules they share. They load together as one chunk, so the home page asks for one file
// where it asked for a dozen (#727). The widgets' own query hooks go with them; the rest of a
// feature stays in its route chunks. The icons only the widgets use (#1119) go with them too:
// left out, five widgets and the arrow of their links became files of their own. An icon another
// screen also uses must not be listed, or that screen downloads this whole chunk (charts and all).
const HOME_WIDGETS =
  /[\\/]src[\\/](features[\\/][^\\/]+[\\/]components[\\/][A-Za-z]+Widget\.tsx|features[\\/][^\\/]+[\\/]widget-strings\.json|shared[\\/]hooks[\\/]use-widget-strings\.ts|features[\\/][^\\/]+[\\/]hooks[\\/]use-(notices|census|board|queue|lab|inventory|billing|reports)\.ts|shared[\\/]ui[\\/](ring-gauge|stat-card)\.tsx|tenancy[\\/]use-formatters\.ts)$|[\\/]lucide-react[\\/]dist[\\/]esm[\\/]icons[\\/](arrow-down-right|arrow-up-right|equal|file-x|folder-open|image-off|move-right|package-search|receipt-text)\.mjs$/;
// The shell's small modules (API client, session, access, class names), which each cost a file.
const APP_CORE =
  /[\\/]src[\\/](shared[\\/](api|lib)|access|app[\\/]session|tenancy)[\\/]|[\\/]node_modules[\\/](clsx|tailwind-merge|class-variance-authority)[\\/]/;
// Small helpers the shell needs on every page load (dates, masks, text rules), as one file.
const SHARED_UTILS = /[\\/]src[\\/]shared[\\/]utils[\\/]/;

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    analyze &&
      (visualizer({
        filename: 'stats.html',
        gzipSize: true,
        brotliSize: true,
        open: false,
      }) as PluginOption),
  ],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    strictPort: true,
    // The real API, for running without the mock (VITE_API_MOCKING=disabled). The browser only
    // ever talks to this origin, so the session cookie and the API's cross-site check work as
    // they do in production, where the CDN routes /api to the API. With the mock on, the service
    // worker answers first and nothing reaches the proxy.
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET ?? 'http://localhost:3000',
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'vendor', test: VENDOR },
            { name: 'home-widgets', test: HOME_WIDGETS, includeDependenciesRecursively: false },
            { name: 'app-core', test: APP_CORE, includeDependenciesRecursively: false },
            { name: 'shared-utils', test: SHARED_UTILS, includeDependenciesRecursively: false },
          ],
        },
        // Strip console.* and debugger statements from production bundles.
        minify: { compress: { dropConsole: true, dropDebugger: true } },
      },
    },
  },
});
