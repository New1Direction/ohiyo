// The app's version, stamped in at build time from package.json (vite.config.ts `define`).
// Tests and other bundlers that don't stamp it get "dev".
declare const __OHIYO_VERSION__: string | undefined;

export const APP_VERSION: string = typeof __OHIYO_VERSION__ === "string" ? __OHIYO_VERSION__ : "dev";
