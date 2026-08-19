import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: './src/web',
  build: {
    outDir: path.resolve(__dirname, 'public'),
    emptyOutDir: true,
    // The manifest is consumed by scripts/check-frontend-bundle.mjs. Keep the
    // budget independent of content hashes and terminal-output formatting.
    manifest: true,
    // vis-network is an intentionally large, rarely loaded graph dependency.
    // Its reviewed exception is enforced separately from ordinary chunks by
    // the manifest budget; this ceiling only suppresses Vite's less-specific
    // warning for that one known chunk.
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const graphPackages = [
            '/node_modules/vis-network/',
            '/node_modules/vis-data/',
            '/node_modules/vis-util/',
            '/node_modules/component-emitter/',
            '/node_modules/keycharm/',
            '/node_modules/uuid/',
          ];
          if (graphPackages.some((packagePath) => id.includes(packagePath))) {
            return 'vendor-graph';
          }
        },
      },
    },
  },
  server: {
    // 5173 by default; PORT lets a second dev instance run alongside the first.
    port: process.env.PORT ? Number(process.env.PORT) : 5173,
    proxy: {
      // Anchored regexes: a bare '/api' prefix match also swallows the
      // `/api.ts` source module and leaves the dev UI blank.
      '^/api/': {
        target: 'http://localhost:6878',
        changeOrigin: true,
      },
      // Exact match only — the real endpoint is POST /mcp with no
      // sub-paths. A prefix match would also swallow the SPA's own
      // /mcp/authorize consent screen (MUS-29) and proxy it to the backend
      // instead of letting vite serve the dev-mode index.html.
      '^/mcp$': {
        target: 'http://localhost:6878',
        changeOrigin: true,
      },
    },
  },
});
