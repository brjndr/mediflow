import { fileURLToPath, URL } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import { defineConfig, type PluginOption } from 'vite';

const analyze = process.env.ANALYZE === 'true';

// Only stable vendor libraries go in the long-cached vendor chunk (CLAUDE.md Performance > Build).
const VENDOR =
  /[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|@remix-run[\\/]router|@tanstack[\\/](react-query|query-core))[\\/]/;

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
  server: { port: 5173, strictPort: true },
  build: {
    target: 'es2022',
    sourcemap: false,
    rolldownOptions: {
      output: {
        codeSplitting: { groups: [{ name: 'vendor', test: VENDOR }] },
        // Strip console.* and debugger statements from production bundles.
        minify: { compress: { dropConsole: true, dropDebugger: true } },
      },
    },
  },
});
