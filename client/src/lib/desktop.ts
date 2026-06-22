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

/**
 * Returns true if THIS tab/window should fire the OS notification for message `id`.
 * With several tabs open they'd otherwise each fire their own — a true double-ping.
 * Uses the Web Locks API (only one claimant wins the lock) and falls back to a short
 * localStorage claim window where Web Locks isn't available.
 */
export async function claimNotification(id: string): Promise<boolean> {
  type LockReq = (
    name: string,
    opts: { ifAvailable: boolean },
    cb: (lock: unknown) => Promise<void>
  ) => Promise<void>;
  const locks = (navigator as unknown as { locks?: { request?: LockReq } }).locks;
  if (locks?.request) {
    return new Promise<boolean>((resolve) => {
      locks
        .request!(`kc-notif:${id}`, { ifAvailable: true }, async (lock) => {
          if (!lock) {
            resolve(false); // another tab already holds it → it notifies, we don't
            return;
          }
          resolve(true);
          // Hold briefly so a racing tab's ifAvailable request sees it taken.
          await new Promise((r) => setTimeout(r, 4000));
        })
        .catch(() => resolve(true));
    });
  }
  // Fallback: a shared localStorage claim window (best-effort; tiny residual race).
  try {
    const KEY = "kc:last-notif";
    const now = Date.now();
    const prev = JSON.parse(localStorage.getItem(KEY) || "null") as { id: string; t: number } | null;
    if (prev && prev.id === id && now - prev.t < 4000) return false;
    localStorage.setItem(KEY, JSON.stringify({ id, t: now }));
    return true;
  } catch {
    return true;
  }
}

// Invite codes are server-generated tokens; constrain to a conservative,
// URL-safe shape so a malformed/hostile deep link can't smuggle arbitrary
// content (path traversal, query injection, oversized payloads) downstream.
const INVITE_CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Parse an `ohiyo://invite/<code>` (or legacy `kikkacord://`, or `?invite=<code>`) URL into its code. */
export function parseInviteUrl(url: string): string | null {
  try {
    const u = new URL(url);
    let code: string | null = null;
    if (u.protocol === "ohiyo:" || u.protocol === "kikkacord:") {
      // ohiyo://invite/CODE → hostname="invite", pathname="/CODE"
      // ohiyo://CODE        → hostname="CODE"
      const fromPath = u.pathname.replace(/^\/+/, "").trim();
      if (u.hostname === "invite") code = fromPath || null;
      else if (u.hostname) code = u.hostname;
      else code = fromPath || null;
    } else {
      const q = u.searchParams.get("invite");
      code = q && q.trim() ? q.trim() : null;
    }
    // Reject anything that isn't a plausible invite code.
    return code && INVITE_CODE_RE.test(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * Register a handler for `ohiyo://` deep links — both ones that launched the
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
