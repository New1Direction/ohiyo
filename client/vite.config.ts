import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Content-Security-Policy for the SPA document — the primary defense against XSS (and
// thus against session-token theft from web storage). script-src 'self' with NO
// 'unsafe-inline'/'unsafe-eval' is the key line: injected <script> / eval can't run.
// style-src needs 'unsafe-inline' (the app uses inline style={{}} everywhere — those
// can't execute JS). Injected ONLY into the production build via apply:'build', so it
// never interferes with Vite's dev HMR (which relies on eval/inline).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self' https: wss:",
  "worker-src 'self' blob:",
  "frame-src https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

function cspPlugin() {
  return {
    name: "inject-csp",
    apply: "build" as const,
    transformIndexHtml(html: string) {
      return html.replace(
        "</head>",
        `  <meta http-equiv="Content-Security-Policy" content="${CSP}" />\n  </head>`,
      );
    },
  };
}

export default defineConfig(async () => ({
  plugins: [tailwindcss(), react(), cspPlugin()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
