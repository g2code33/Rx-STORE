import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

/**
 * Production configuration guard (Prompt 10 §20 — fail clearly, never silently).
 *
 * A production bundle MUST be wired to a real backend via VITE_API_URL. Without
 * it the client would silently ship "unconfigured": every API call fails and
 * the storefront can only show its cached catalog — that must never look like a
 * successful release build. A localhost URL in a production build is almost
 * always a mistake (real users cannot reach the developer's machine), so it is
 * rejected the same way.
 *
 * Escape hatch: `VITE_ALLOW_UNCONFIGURED=1` explicitly opts out (e.g. CI smoke
 * builds / preview bundles that intentionally run without a backend). It is a
 * deliberate, logged choice — not a silent fallback.
 */
function productionApiGuard(): Plugin {
  return {
    name: 'rx-store-production-api-guard',
    apply: 'build',
    configResolved(config) {
      if (config.mode !== 'production') return;
      if (config.command !== 'build') return;
      const env = config.env || {};
      if (String(env.VITE_ALLOW_UNCONFIGURED || '') === '1') {
        console.warn(
          '[rx-store] VITE_ALLOW_UNCONFIGURED=1 — building a production bundle WITHOUT a backend API URL. ' +
            'Every network feature (catalog, accounts, downloads) will be unavailable at runtime.',
        );
        return;
      }
      const api = String(env.VITE_API_URL || '').trim();
      if (!api) {
        throw new Error(
          '[rx-store] Production build is missing VITE_API_URL. ' +
            'Set it to your deployed backend origin, e.g.:\n' +
            '  VITE_API_URL=https://api.rxstore.com npm run build:web\n' +
            'To intentionally build without a backend (previews/CI smoke), set VITE_ALLOW_UNCONFIGURED=1.',
        );
      }
      if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(api)) {
        throw new Error(
          `[rx-store] Production build points VITE_API_URL at a localhost address (${api}). ` +
            'Real users cannot reach a local development machine. Point it at your deployed backend, ' +
            'or set VITE_ALLOW_UNCONFIGURED=1 if this is intentionally a local-only build.',
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), productionApiGuard()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    allowedHosts: true,
  },
});
