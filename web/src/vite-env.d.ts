/// <reference types="vite/client" />

/** The version in package.json, set at build time (vite.config.ts). */
declare const __APP_VERSION__: string;

interface ImportMetaEnv {
  /** Shared pages: whose notes they are, and where their name links to (.env.local). */
  readonly VITE_SHARE_OWNER?: string;
  readonly VITE_SHARE_OWNER_URL?: string;
}
