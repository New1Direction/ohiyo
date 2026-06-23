import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Derive the WS origin (wss://… / ws://…) from an http(s) backend origin so the
// real-time socket connection is allowed without falling back to a blanket
// `wss:`. Returns null if the value isn't a usable absolute origin.
function wsOriginFrom(httpOrigin: string | undefined): string | null {
  if (!httpOrigin) return null;
  try {
    const u = new URL(httpOrigin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProto}//${u.host}`;
  } catch {
    return null;
  }
}

// Content-Security-Policy for the SPA document — the primary defense against XSS (and
// thus against session-token theft from web storage). script-src 'self' with NO
// 'unsafe-inline'/'unsafe-eval' is the key line: injected <script> / eval can't run.
// style-src needs 'unsafe-inline' (the app uses inline style={{}} everywhere — those
// can't execute JS). Injected ONLY into the production build via apply:'build', so it
// never interferes with Vite's dev HMR (which relies on eval/inline).
//
// NOTE: `connect-src` is narrowed to 'self' plus the configured backend origin
// (VITE_SERVER_URL) instead of a blanket `https: wss:`. If VITE_SERVER_URL is
// unset at build time we fall back to 'self' only — set it for any deployment
// that talks to a separate API/WS host.
//
// NOTE: This is a build-time <meta> CSP and is intentionally a baseline only.
// A production-grade CSP — including `frame-ancestors` (which a <meta> tag
// CANNOT set), a nonce-based `script-src`, and HSTS/other security headers —
// MUST be delivered as a real HTTP response header by the web server / CDN that
// serves index.html. Setting response headers is not this file's job.
function buildCsp(serverUrl: string | undefined): string {
  const connect = new Set<string>(["'self'"]);
  if (serverUrl) {
    try {
      const u = new URL(serverUrl);
      if (u.protocol === "http:" || u.protocol === "https:") {
        connect.add(u.origin);
        const ws = wsOriginFrom(serverUrl);
        if (ws) connect.add(ws);
      }
    } catch {
      // ignore an unparseable VITE_SERVER_URL — fall back to 'self' only
    }
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    `connect-src ${Array.from(connect).join(" ")}`,
    "worker-src 'self' blob:",
    "frame-src https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

function cspPlugin(csp: string) {
  return {
    name: "inject-csp",
    apply: "build" as const,
    transformIndexHtml(html: string) {
      return html.replace(
        "</head>",
        `  <meta http-equiv="Content-Security-Policy" content="${csp}" />\n  </head>`,
      );
    },
  };
}

export default defineConfig(async ({ mode }) => {
  // Load VITE_* env vars for this mode (does not mutate process.env).
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const csp = buildCsp(env.VITE_SERVER_URL);
  return {
  plugins: [tailwindcss(), react(), cspPlugin(csp)],
  clearScreen: false,
  build: {
    // LiveKit is isolated into its own lazy vendor chunk and lands just above Vite's
    // default 500 kB warning. Keep the warning threshold tight for the app while
    // acknowledging that this single SFU/media SDK chunk is intentional.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (id.includes("livekit-client")) return "vendor-livekit";
          if (id.includes("@privacyresearch") || id.includes("libsignal")) return "vendor-crypto";
          if (id.includes("react-window") || id.includes("react-virtualized-auto-sizer")) return "vendor-virtual-list";
          if (id.includes("@tauri-apps")) return "vendor-tauri";
          if (id.includes("react") || id.includes("react-dom") || id.includes("scheduler")) return "vendor-react";
          return undefined;
        },
      },
    },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  };
});
