/**
 * @rx-store/sdk — entry point (framework-free core).
 *
 * The React integration is a SEPARATE subpath so the core never requires React:
 *   import { createRxStoreSDK } from '@rx-store/sdk';
 *   import { RxStoreUpdateBanner } from '@rx-store/sdk/react';   // optional
 */
export * from './core/index.ts';
