/**
 * Runtime smoke test: import the INSTALLED @rx-store/sdk package (the packed
 * tarball, not the repo sources) in plain Node and exercise the core API.
 * Run from sdk/sample-app after `npm install`.
 */
import assert from 'node:assert/strict';
import { createRxStoreSDK, validateConfig } from '@rx-store/sdk';

const sdk = createRxStoreSDK({
  appId: 'pharmatrack',
  currentVersion: '1.1.4',
  platform: 'android',
  fetchImpl: async () => new Response(JSON.stringify({
    success: true,
    data: {
      slug: 'pharmatrack', app: 'PharmaTRACK', latestVersion: '1.1.5',
      updateAvailable: true, mandatory: false,
      storeUrl: 'https://rx-store-web.pages.dev/app/pharmatrack',
      deepLink: 'rxstore://app/pharmatrack',
      checkedAt: new Date().toISOString(),
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
});

const result = await sdk.checkForUpdate({ force: true });
assert.equal(result.status, 'UPDATE_AVAILABLE');
assert.equal(result.update.latestVersion, '1.1.5');
assert.equal(sdk.buildDeepLink(), 'rxstore://app/pharmatrack');
assert.equal(sdk.buildStoreUrl(), 'https://rx-store-web.pages.dev/app/pharmatrack');
assert.equal(sdk.hasUpdate(), true);
// Config validation rejects incomplete configs (never silently dead).
assert.match(String(validateConfig({ appId: 'x' })), /currentVersion must be a valid SemVer/);
sdk.destroy();
console.log('smoke: installed @rx-store/sdk works in plain Node ✓');
