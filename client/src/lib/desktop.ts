/**
 * Desktop (Tauri) integration shims.
 *
 * Every export degrades gracefully in a plain browser (Vite dev server, e2e),
 * so the exact same client code runs both as a website and inside the packaged
 * desktop app. Tauri plugin modules are imported dynamically and only when we
 * are actually running inside Tauri — so the browser bundle never touches them.
 */

/** True when running inside the packaged Tauri desktop app. */
export function isDesktop(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

type NotifyOptions = {
  title: string;
  body: string;
};

/**
 * Show a notification — native OS notification under Tauri, Web Notification in
 * a browser. Silently no-ops when permission is denied or unavailable.
 */
export async function notify({ title, body }: NotifyOptions): Promise<void> {
  if (isDesktop()) {
    try {
      const { isPermissionGranted, requestPermission, sendNotification } = await import(
        "@tauri-apps/plugin-notification"
      );
      let granted = await isPermissionGranted();
      if (!granted) granted = (await requestPermission()) === "granted";
      if (granted) sendNotification({ title, body });
    } catch {
      /* notification plugin unavailable — ignore */
    }
    return;
  }
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification(title, { body });
  } catch {
    /* some browsers throw on construction — ignore */
  }
}

/** Request notification permission up front (call once, on a user gesture). */
export async function ensureNotificationPermission(): Promise<void> {
  if (isDesktop()) {
    try {
      const { isPermissionGranted, requestPermission } = await import(
        "@tauri-apps/plugin-notification"
      );
      if (!(await isPermissionGranted())) await requestPermission();
    } catch {
      /* ignore */
    }
    return;
  }
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    try {
      await Notification.requestPermission();
    } catch {
      /* ignore */
    }
  }
}

/** Parse a `kikkacord://invite/<code>` (or `?invite=<code>`) URL into its code. */
export function parseInviteUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol === "kikkacord:") {
      // kikkacord://invite/CODE → hostname="invite", pathname="/CODE"
      // kikkacord://CODE        → hostname="CODE"
      const fromPath = u.pathname.replace(/^\/+/, "").trim();
      if (u.hostname === "invite") return fromPath || null;
      if (u.hostname) return u.hostname;
      return fromPath || null;
    }
    const q = u.searchParams.get("invite");
    return q && q.trim() ? q.trim() : null;
  } catch {
    return null;
  }
}

/**
 * Register a handler for `kikkacord://` deep links — both ones that launched the
 * app (cold start) and ones opened while it runs. No-op in the browser.
 * Returns a cleanup function.
 */
export async function initDeepLinks(onInvite: (code: string) => void): Promise<() => void> {
  if (!isDesktop()) return () => {};
  try {
    const { onOpenUrl, getCurrent } = await import("@tauri-apps/plugin-deep-link");
    try {
      const initial = await getCurrent();
      initial?.forEach((url) => {
        const code = parseInviteUrl(url);
        if (code) onInvite(code);
      });
    } catch {
      /* getCurrent unsupported on this platform — ignore */
    }
    return await onOpenUrl((urls) => {
      urls.forEach((url) => {
        const code = parseInviteUrl(url);
        if (code) onInvite(code);
      });
    });
  } catch {
    return () => {};
  }
}
