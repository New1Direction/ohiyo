// A push subscription belongs to the session that registered it: once that session ends
// (sign out everywhere, Not me, a password change) the server stops nudging it. On
// signing in, this browser registers its existing subscription again for the new
// session, so its own notifications carry on. The browser APIs are passed in (push.ts
// supplies them) so this runs under plain `node --test`.

export type PushRegistration = {
  platform: "web";
  endpoint: string;
  p256dh: string;
  auth: string;
  device_name: string;
};

export type PushRenewDeps = {
  /** Notification permission ("granted", "default", "denied"), or "unsupported". */
  permission(): string;
  /** This browser's existing subscription with its keys, or null if it never subscribed. */
  subscription(): Promise<{ endpoint: string; p256dh: string | null; auth: string | null } | null>;
  deviceName: string;
  register(body: PushRegistration): Promise<unknown>;
};

/** Register an existing subscription again. Never asks for permission or subscribes:
 *  without both already in place it does nothing. False when nothing was registered. */
export async function renewPushRegistration(deps: PushRenewDeps): Promise<boolean> {
  if (deps.permission() !== "granted") return false;
  try {
    const sub = await deps.subscription();
    if (!sub?.p256dh || !sub.auth) return false;
    await deps.register({
      platform: "web",
      endpoint: sub.endpoint,
      p256dh: sub.p256dh,
      auth: sub.auth,
      device_name: deps.deviceName,
    });
    return true;
  } catch {
    // Offline, or the server refused: notifications resume on the next sign-in.
    return false;
  }
}
