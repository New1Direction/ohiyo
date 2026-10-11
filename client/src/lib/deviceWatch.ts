// Notices a device being added to your own account.
//
// Every device registers its own encryption keys, and anyone who sends you an encrypted
// message encrypts a copy for each one. So a stolen session (a copied token, an unlocked
// laptop) could add a device and read every message sent after that, and nothing would
// say so. Each device keeps the list of the account's devices it last saw; a device that
// appears later is held here as "new" until you say it was you or remove it.
//
// The server announces a new device at once (gateway DeviceAdded), and the list is
// checked again at every sign-in, so a device added while this one was closed is caught
// too. The first check on a device only records the list: devices that were there before
// it signed in are not news to it.
//
// The list comes from the server. A malicious server could hide a device from you and
// show it to others; comparing safety numbers is what catches that.

export type NewDevice = { device_id: number; seen_at: number };

type Store = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
};

let store: Store = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
  removeItem: (k) => localStorage.removeItem(k),
};

/** Tests swap in a map. */
export function setDeviceWatchStore(s: Store): void {
  store = s;
}

const KNOWN = "ohiyo:known-devices:";
const NEW = "ohiyo:new-devices:";

const listeners = new Set<() => void>();
/** For useSyncExternalStore: called whenever any account's new-device list changes. */
export function onNewDevicesChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
function notify(): void {
  for (const cb of [...listeners]) cb();
}

function read<T>(key: string, valid: (v: unknown) => v is T): T | null {
  try {
    const raw = store.getItem(key);
    if (raw === null) return null;
    const v: unknown = JSON.parse(raw);
    return valid(v) ? v : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or disabled: the next sign-in checks again */
  }
}

const isIdList = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => Number.isInteger(n));
const isNewList = (v: unknown): v is NewDevice[] =>
  Array.isArray(v) &&
  v.every((e) => typeof e === "object" && e !== null && Number.isInteger((e as NewDevice).device_id) && typeof (e as NewDevice).seen_at === "number");

// Cached per account so useSyncExternalStore gets a stable snapshot between changes.
const snapshots = new Map<string, NewDevice[]>();
const EMPTY: NewDevice[] = [];

/** Devices added to this account since this device last looked, not yet acknowledged. */
export function newDevices(userId: string): NewDevice[] {
  const cached = snapshots.get(userId);
  if (cached) return cached;
  const list = read(NEW + userId, isNewList) ?? EMPTY;
  snapshots.set(userId, list);
  return list;
}

function setNew(userId: string, list: NewDevice[]): void {
  const before = newDevices(userId);
  const same = before.length === list.length && before.every((d, i) => d.device_id === list[i].device_id);
  if (list.length === 0) {
    try {
      store.removeItem(NEW + userId);
    } catch {
      /* storage disabled */
    }
  } else {
    write(NEW + userId, list);
  }
  snapshots.set(userId, list.length === 0 ? EMPTY : list);
  if (!same) notify();
}

/**
 * Compare the account's device list with the one this device saw last, and remember the
 * new list. Returns the devices still waiting to be acknowledged. A device is never new
 * to itself, and a device that has left the account stops being new.
 */
export function reconcileOwnDevices(userId: string, thisDevice: number, listed: readonly number[], now = Math.floor(Date.now() / 1000)): NewDevice[] {
  const known = read(KNOWN + userId, isIdList);
  const onAccount = new Set(listed);
  const pending = newDevices(userId).filter((d) => onAccount.has(d.device_id));
  if (known !== null) {
    const seen = new Set([...known, ...pending.map((d) => d.device_id)]);
    for (const id of listed) {
      if (id !== thisDevice && !seen.has(id)) pending.push({ device_id: id, seen_at: now });
    }
  }
  write(KNOWN + userId, [...new Set([...listed, thisDevice])].sort((a, b) => a - b));
  setNew(userId, pending);
  return pending;
}

/** "It was me": the new devices are yours. They stay on the account. */
export function acknowledgeNewDevices(userId: string): void {
  setNew(userId, []);
}

/** The devices were removed from the account. Forget them, so one that comes back is
 *  new again rather than already known. */
export function forgetDevices(userId: string, ids: readonly number[]): void {
  const drop = new Set(ids);
  const known = read(KNOWN + userId, isIdList);
  if (known) write(KNOWN + userId, known.filter((id) => !drop.has(id)));
  setNew(userId, newDevices(userId).filter((d) => !drop.has(d.device_id)));
}
