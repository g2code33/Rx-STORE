/**
 * RX Store SDK sample application (§ production gate 11).
 *
 * A normal React + Vite app that consumes @rx-store/sdk EXACTLY the way an
 * external developer would: install the published package, import the core
 * from '@rx-store/sdk' and the optional banner from '@rx-store/sdk/react',
 * check for updates, read metadata and build the deep link / HTTPS fallback.
 * It never downloads or installs anything — RX Store does that.
 */
import React, { useEffect, useState } from 'react';
import { createRxStoreSDK, type UpdateCheckResult } from '@rx-store/sdk';
import { RxStoreUpdateBanner } from '@rx-store/sdk/react';

const APP_VERSION = '1.1.4'; // what this "app" ships as

export const rxStore = createRxStoreSDK({
  appId: 'pharmatrack',        // this sample mirrors the documented example
  currentVersion: APP_VERSION,
  platform: 'android',         // explicit override — never trust a browser UA
  channel: 'stable',
});

export default function App() {
  const [result, setResult] = useState<UpdateCheckResult | null>(null);

  useEffect(() => {
    let alive = true;
    void rxStore.initialize();
    void rxStore.checkForUpdate({ force: true }).then((r) => { if (alive) setResult(r); });
    return () => { alive = false; };
  }, []);

  const update = result?.update;
  return (
    <main style={{ fontFamily: 'system-ui', padding: 24 }}>
      <h1>Host application (RX Store SDK sample)</h1>
      <p>
        {result == null
          ? 'Checking RX Store for updates…'
          : result.status === 'UPDATE_AVAILABLE' || result.status === 'MANDATORY_UPDATE'
            ? `${update?.appName ?? 'App'} v${update?.latestVersion} is available (current: v${APP_VERSION}).`
            : result.status === 'NO_UPDATE'
              ? 'Up to date.'
              : `Update check unavailable (${result.status}) — the app keeps working.`}
      </p>
      {update && (
        <ul>
          <li>Release notes: {update.releaseNotes.join(', ') || '—'}</li>
          <li>Mandatory: {String(update.mandatory)}</li>
          <li>Deep link: <code>{rxStore.buildDeepLink()}</code></li>
          <li>HTTPS fallback: <code>{rxStore.buildStoreUrl()}</code></li>
        </ul>
      )}
      <button type="button" onClick={() => rxStore.openUpdateInRxStore()}>
        Update via RX Store
      </button>
      {/* The optional, ready-made banner (mandatory-aware, dismissible). */}
      <RxStoreUpdateBanner sdk={rxStore} />
    </main>
  );
}
