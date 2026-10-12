// Signal multi-device fan-out: one copy per device of each recipient user. Every send
// refreshes each user's device list from the identity-key directory (which consumes no
// one-time prekeys), and fetches prekey bundles — which consume one prekey per device —
// only when some listed device has no session yet. A steady conversation therefore
// burns no prekeys, and a device added since the last send still gets its copy on the
// next one. The I/O is injected (signal.ts supplies it) so this is unit-testable.
//
// The directory is what device warnings and safety numbers are built from, so it alone
// decides who gets a copy: a bundle for a device it doesn't list, or under a key it
// doesn't list, starts no session. A server could otherwise add a reader that no warning
// shows and no safety number catches. And when the directory can't be read the send
// fails, rather than trusting the bundle list instead.

export type FanoutEnvelope = { t: number; b: string };

/** A device as the directory lists it. */
export type ListedDevice = { device_id: number; identity_key: string };

export type FanoutDeps<B extends ListedDevice> = {
  /** Every device the directory lists for a user, with its identity key; consumes no
   *  prekeys. May throw. */
  listDevices(userId: string): Promise<ListedDevice[]>;
  /** A bundle for each of a user's devices; consumes a one-time prekey on each. May throw. */
  fetchBundles(userId: string): Promise<B[]>;
  hasSession(userId: string, deviceId: number): Promise<boolean>;
  /** Build a session from a bundle; false if the bundle is unusable. */
  startSession(userId: string, bundle: B): Promise<boolean>;
  encrypt(userId: string, deviceId: number): Promise<FanoutEnvelope>;
};

/** Encrypt a copy for every listed device of every user in `userIds`, except this device
 *  (`self`). Keys are `"<userId>.<deviceId>"`; a device without a usable session is
 *  skipped. Throws, encrypting nothing, if a user's device list can't be read. */
export async function fanOut<B extends ListedDevice>(
  userIds: readonly string[],
  self: { userId: string | null; deviceId: number },
  deps: FanoutDeps<B>,
): Promise<Record<string, FanoutEnvelope>> {
  const listedKeys = new Map<string, Map<number, string>>();
  for (const uid of userIds) {
    const notSelf = (d: number) => !(uid === self.userId && d === self.deviceId);
    let listed: ListedDevice[];
    try {
      listed = await deps.listDevices(uid);
    } catch {
      throw new Error("couldn't check this person's devices; nothing was sent");
    }
    listedKeys.set(uid, new Map(listed.filter((d) => notSelf(d.device_id)).map((d) => [d.device_id, d.identity_key])));
  }

  const out: Record<string, FanoutEnvelope> = {};
  for (const uid of userIds) {
    const keys = listedKeys.get(uid)!;
    let needBundles = false;
    for (const d of keys.keys()) if (!(await deps.hasSession(uid, d))) needBundles = true;
    if (needBundles) {
      let bundles: B[];
      try {
        bundles = await deps.fetchBundles(uid);
      } catch {
        bundles = [];
      }
      for (const b of bundles) {
        // Only a listed device, under the key the directory lists for it.
        if (keys.get(b.device_id) !== b.identity_key) continue;
        if (!(await deps.hasSession(uid, b.device_id))) await deps.startSession(uid, b);
      }
    }
    for (const d of keys.keys()) {
      if (!(await deps.hasSession(uid, d))) continue;
      out[`${uid}.${d}`] = await deps.encrypt(uid, d);
    }
  }
  return out;
}
