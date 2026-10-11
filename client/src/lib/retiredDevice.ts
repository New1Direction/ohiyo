// After a key restore this device carries the backed-up device's Signal id and keys, so
// the id it signed in with is left in the account's device list with keys nobody holds.
// Senders would keep encrypting a copy of every message to it that no one can read, and
// it would count toward the account's device limit. The restore removes it from the
// server; if that call fails, the id is kept here and removed on the next start.

const PENDING = "ohiyo:retired-signal-device";

type Pending = { user_id: string; device_id: number };

function load(): Pending | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PENDING) ?? "null");
    if (typeof v !== "object" || v === null) return null;
    const { user_id, device_id } = v as Record<string, unknown>;
    return typeof user_id === "string" && typeof device_id === "number" ? { user_id, device_id } : null;
  } catch {
    return null;
  }
}

function save(p: Pending): void {
  try {
    localStorage.setItem(PENDING, JSON.stringify(p));
  } catch {
    /* storage disabled: the old id stays listed under Linked devices, where it can be removed */
  }
}

function clear(): void {
  try {
    localStorage.removeItem(PENDING);
  } catch {
    /* storage disabled */
  }
}

/** Remove the replaced device id from the account. Never throws: on failure the id is
 *  remembered for retryRetiredDevice. Returns whether it was removed now. */
export async function retireDevice(
  remove: (deviceId: number) => Promise<unknown>,
  userId: string | null,
  deviceId: number,
): Promise<boolean> {
  try {
    await remove(deviceId);
    clear();
    return true;
  } catch {
    if (userId) save({ user_id: userId, device_id: deviceId });
    return false;
  }
}

/** On start: finish a removal that failed during a restore. Only for the same account,
 *  and never for the device in use. */
export async function retryRetiredDevice(
  remove: (deviceId: number) => Promise<unknown>,
  userId: string,
  currentDevice: () => number,
): Promise<void> {
  const p = load();
  if (!p || p.user_id !== userId) return;
  if (p.device_id === currentDevice()) {
    clear();
    return;
  }
  try {
    await remove(p.device_id);
    clear();
  } catch {
    /* still failing: try again next start */
  }
}
