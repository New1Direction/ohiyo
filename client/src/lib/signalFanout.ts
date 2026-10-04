// Signal multi-device fan-out: one copy per device of each recipient user. Every send
// refreshes each user's device list from the identity-key directory (which consumes no
// one-time prekeys), and fetches prekey bundles — which consume one prekey per device —
// only when some listed device has no session yet. A steady conversation therefore
// burns no prekeys, and a device added since the last send still gets its copy on the
// next one. The I/O is injected (signal.ts supplies it) so this is unit-testable.

export type FanoutEnvelope = { t: number; b: string };

export type FanoutDeps<B extends { device_id: number }> = {
  /** Every device the directory lists for a user; consumes no prekeys. May throw. */
  listDevices(userId: string): Promise<number[]>;
  /** A bundle for each of a user's devices; consumes a one-time prekey on each. May throw. */
  fetchBundles(userId: string): Promise<B[]>;
  hasSession(userId: string, deviceId: number): Promise<boolean>;
  /** Build a session from a bundle; false if the bundle is unusable. */
  startSession(userId: string, bundle: B): Promise<boolean>;
  encrypt(userId: string, deviceId: number): Promise<FanoutEnvelope>;
};

/** Encrypt a copy for every device of every user in `userIds`, except this device
 *  (`self`). Keys are `"<userId>.<deviceId>"`; a device without a usable session is skipped. */
export async function fanOut<B extends { device_id: number }>(
  userIds: readonly string[],
  self: { userId: string | null; deviceId: number },
  deps: FanoutDeps<B>,
): Promise<Record<string, FanoutEnvelope>> {
  const out: Record<string, FanoutEnvelope> = {};
  for (const uid of userIds) {
    const notSelf = (d: number) => !(uid === self.userId && d === self.deviceId);
    let listed: number[] | null;
    try {
      listed = (await deps.listDevices(uid)).filter(notSelf);
    } catch {
      listed = null; // directory unreachable: fall back to the bundle list
    }
    const targets = new Set(listed ?? []);
    let needBundles = listed === null;
    for (const d of targets) if (!(await deps.hasSession(uid, d))) needBundles = true;
    if (needBundles) {
      let bundles: B[];
      try {
        bundles = await deps.fetchBundles(uid);
      } catch {
        bundles = [];
      }
      for (const b of bundles) {
        if (!notSelf(b.device_id)) continue;
        targets.add(b.device_id);
        if (!(await deps.hasSession(uid, b.device_id))) await deps.startSession(uid, b);
      }
    }
    for (const d of targets) {
      if (!(await deps.hasSession(uid, d))) continue;
      out[`${uid}.${d}`] = await deps.encrypt(uid, d);
    }
  }
  return out;
}
