// Vite config for the IHG Guest Search SPA (task 12.1).
//
// The app is same-origin with the BFF in both environments (design.md "Overview"):
//   - production: the Fastify BFF serves apps/web/dist and the /api + /health routes
//     from one origin, so there is no CORS and no cross-origin cookie handling.
//   - development: Vite serves the SPA and PROXIES /api and /health to the BFF, which
//     reproduces that same-origin contract. This keeps the browser calling its own
//     origin (api/client.ts uses same-origin fetch) and lets the BFF stay CORS-free.
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

// The BFF dev port. Overridable so a developer can point the proxy elsewhere
// without editing the config (defaults to the BFF's documented port 3000).
const BFF_TARGET = process.env.BFF_PROXY_TARGET ?? 'http://localhost:3000';

export default defineConfig({
  // Resolve @ihg-guest-search/shared to its TypeScript source (matches the
  // customConditions in tsconfig.base.json), so the app builds without a prior
  // package build step.
  resolve: {
    conditions: ['@ihg-guest-search/source'],
  },
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: BFF_TARGET, changeOrigin: false },
      '/health': { target: BFF_TARGET, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
