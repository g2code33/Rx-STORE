export {
  createRxStoreSDK,
  validateConfig,
  DEFAULT_API_URL,
  DEFAULT_WEB_URL,
} from './createRxStoreSDK.ts';
export { detectPlatform, archFromUa } from './platform.ts';
export { isValidSemver, parseSemver, compareVersions } from './semver.ts';
export { deriveBannerState } from './banner.ts';
export type { DismissedState, BannerState } from './banner.ts';
export type {
  RxStoreSDK, RxStoreSDKConfig, SdkPlatform,
  UpdateCheckResult, UpdateCheckStatus, UpdateInfo,
} from './types.ts';
