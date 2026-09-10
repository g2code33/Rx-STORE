/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  /** Explicit opt-out of the production API guard (previews / CI smoke builds). */
  readonly VITE_ALLOW_UNCONFIGURED?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
