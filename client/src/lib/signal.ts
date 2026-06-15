// Signal Protocol engine — forward-secret, async (X3DH) sessions + Double Ratchet,
// via @privacyresearch/libsignal-protocol-typescript (a maintained TS port — no
// hand-rolled crypto). Private keys + ratchet state live only on this device
// (localStorage); the server holds public prekeys + ciphertext. Invisible to users.

import {
  KeyHelper,
  SignalProtocolAddress,
  SessionBuilder,
  SessionCipher,
} from "@privacyresearch/libsignal-protocol-typescript";
import { api } from "../api";

const NS = "kc:sig:";
const PREKEY_BATCH = 100;
const PREKEY_LOW = 20;
const ENVELOPE = /^sig1\.(\d)\.([\s\S]+)$/; // legacy single-device envelope
const LEGACY_DEVICE = 1;

type KeyPair = { pubKey: ArrayBuffer; privKey: ArrayBuffer };

const ab2b64 = (ab: ArrayBuffer): string => {
  const u = new Uint8Array(ab);
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s);
};
const b642ab = (s: string): ArrayBuffer => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;

// ── Pluggable storage (localStorage in the browser; injectable for tests) ──────
export type SignalBackend = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  keys(): string[];
};
let backend: SignalBackend = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
  removeItem: (k) => localStorage.removeItem(k),
  keys: () => Object.keys(localStorage),
};
export function setSignalBackend(b: SignalBackend) {
  backend = b;
}

function enc(v: unknown): string {
  if (v instanceof ArrayBuffer) return JSON.stringify({ t: "ab", v: ab2b64(v) });
  const kp = v as KeyPair;
  if (kp && kp.pubKey instanceof ArrayBuffer && kp.privKey instanceof ArrayBuffer) {
    return JSON.stringify({ t: "kp", pub: ab2b64(kp.pubKey), priv: ab2b64(kp.privKey) });
  }
  return JSON.stringify({ t: "raw", v });
}
function dec(s: string): unknown {
  const o = JSON.parse(s);
  if (o.t === "ab") return b642ab(o.v);
  if (o.t === "kp") return { pubKey: b642ab(o.pub), privKey: b642ab(o.priv) };
  return o.v;
}

// ── SignalProtocolStore (the lib's storage interface) ──────────────────────────
class SignalStore {
  private get(key: string): unknown {
    const s = backend.getItem(NS + key);
    return s === null ? undefined : dec(s);
  }
  private put(key: string, v: unknown) {
    backend.setItem(NS + key, enc(v));
  }
  private del(key: string) {
    backend.removeItem(NS + key);
  }

  async getIdentityKeyPair() {
    return this.get("identityKey") as KeyPair | undefined;
  }
  async getLocalRegistrationId() {
    return this.get("registrationId") as number | undefined;
  }
  setOwnIdentity(kp: KeyPair, regId: number) {
    this.put("identityKey", kp);
    this.put("registrationId", regId);
  }
  nextPreKeyId(): number {
    return (this.get("nextPreKeyId") as number) ?? 1;
  }
  setNextPreKeyId(n: number) {
    this.put("nextPreKeyId", n);
  }

  async isTrustedIdentity(_id: string, _key: ArrayBuffer) {
    // Multi-device: each device has its OWN identity key, but the library only passes
    // the bare user id here (no device), so we can't tell a new device from a changed
    // key. Trust on first use; real verification is the out-of-band safety number.
    return true;
  }
  async loadIdentityKey(id: string) {
    return this.get("identity" + id) as ArrayBuffer | undefined;
  }
  async saveIdentity(id: string, key: ArrayBuffer) {
    // Store per FULL address ("user.device") so a user's devices don't overwrite
    // each other (the library calls this with remoteAddress.toString()).
    const e = this.get("identity" + id) as ArrayBuffer | undefined;
    this.put("identity" + id, key);
    return e !== undefined && ab2b64(key) !== ab2b64(e);
  }

  async loadPreKey(id: number | string) {
    const r = this.get("prekey" + id) as KeyPair | undefined;
    return r && { pubKey: r.pubKey, privKey: r.privKey };
  }
  async storePreKey(id: number | string, kp: KeyPair) {
    this.put("prekey" + id, kp);
  }
  async removePreKey(id: number | string) {
    this.del("prekey" + id);
  }
  async loadSignedPreKey(id: number | string) {
    const r = this.get("signedprekey" + id) as KeyPair | undefined;
    return r && { pubKey: r.pubKey, privKey: r.privKey };
  }
  async storeSignedPreKey(id: number | string, kp: KeyPair) {
    this.put("signedprekey" + id, kp);
  }
  async removeSignedPreKey(id: number | string) {
    this.del("signedprekey" + id);
  }

  async loadSession(id: string) {
    return this.get("session" + id) as string | undefined;
  }
  async storeSession(id: string, rec: string) {
    this.put("session" + id, rec);
  }
  async removeSession(id: string) {
    this.del("session" + id);
  }
  async removeAllSessions(prefix: string) {
    for (const k of backend.keys()) if (k.startsWith(NS + "session" + prefix)) backend.removeItem(k);
  }
}

const store = new SignalStore();
const randId = () => Math.floor(Math.random() * 0x7fffffff);

// ── This device's stable id + our own user id (multi-device addressing) ─────────
/** A stable per-device id (this browser/install), generated once and persisted. */
function getDeviceId(): number {
  let d = backend.getItem(NS + "deviceId");
  if (!d) {
    d = String(1 + Math.floor(Math.random() * 0x7ffffffe)); // 1..2^31-1
    backend.setItem(NS + "deviceId", d);
  }
  return parseInt(d, 10);
}
export function deviceId(): number {
  return getDeviceId();
}
function ownUserId(): string | null {
  return backend.getItem(NS + "ownUserId");
}

/** Generate this device's identity + prekeys on first run + publish; replenish
 *  one-time prekeys when low. Safe to call on every login. */
export async function initSignal(token: string): Promise<void> {
  // Remember our own user id so we can fan out to (and decrypt for) our own devices.
  try {
    const me = await api.me(token);
    backend.setItem(NS + "ownUserId", me.id);
  } catch {
    /* offline — peers still work; own-device sync needs this on next online init */
  }
  const dev = getDeviceId();
  if (!(await store.getIdentityKeyPair())) {
    const idKP = await KeyHelper.generateIdentityKeyPair();
    const regId = await KeyHelper.generateRegistrationId();
    store.setOwnIdentity(idKP, regId);
    await publish(token, dev);
  } else {
    try {
      const { count } = await api.signalPrekeyCount(token, dev);
      if (count < PREKEY_LOW) await publish(token, dev);
    } catch {
      /* offline — not critical */
    }
  }
}

// Fresh signed prekey + a batch of one-time prekeys → store + publish (this device).
async function publish(token: string, dev: number): Promise<void> {
  const idKP = (await store.getIdentityKeyPair())!;
  const regId = (await store.getLocalRegistrationId())!;
  const signedId = randId();
  const spk = await KeyHelper.generateSignedPreKey(idKP, signedId);
  await store.storeSignedPreKey(signedId, spk.keyPair);
  const start = store.nextPreKeyId();
  const otks: { key_id: number; public_key: string }[] = [];
  for (let i = 0; i < PREKEY_BATCH; i++) {
    const kid = start + i;
    const pk = await KeyHelper.generatePreKey(kid);
    await store.storePreKey(kid, pk.keyPair);
    otks.push({ key_id: kid, public_key: ab2b64(pk.keyPair.pubKey) });
  }
  store.setNextPreKeyId(start + PREKEY_BATCH);
  await api.signalPublishKeys(token, {
    device_id: dev,
    identity_key: ab2b64(idKP.pubKey),
    registration_id: regId,
    signed_prekey: {
      key_id: signedId,
      public_key: ab2b64(spk.keyPair.pubKey),
      signature: ab2b64(spk.signature),
    },
    one_time_prekeys: otks,
  });
}

/** Is stored content a Signal ciphertext envelope (multi-device sig2 or legacy sig1)? */
export function isSignalCiphertext(s: string): boolean {
  return s.startsWith("sig2.") || s.startsWith("sig1.");
}

type Bundle = Awaited<ReturnType<typeof api.getPrekeyBundles>>[number];

// Ensure a session to (uid, device) exists, building it from a fetched bundle.
async function ensureSession(addr: SignalProtocolAddress, bundle: Bundle): Promise<boolean> {
  if (await store.loadSession(addr.toString())) return true;
  const pre = {
    identityKey: b642ab(bundle.identity_key),
    registrationId: bundle.registration_id,
    signedPreKey: {
      keyId: bundle.signed_prekey.key_id,
      publicKey: b642ab(bundle.signed_prekey.public_key),
      signature: b642ab(bundle.signed_prekey.signature),
    },
    ...(bundle.one_time_prekey
      ? { preKey: { keyId: bundle.one_time_prekey.key_id, publicKey: b642ab(bundle.one_time_prekey.public_key) } }
      : {}),
  };
  try {
    await new SessionBuilder(store, addr).processPreKey(pre);
    return true;
  } catch {
    return false;
  }
}

/** Encrypt for a peer, fanning out a copy to EVERY one of the peer's devices and our
 *  own other devices (multi-device). Returns a `sig2.<b64(json)>` envelope, or null if
 *  no Signal-capable recipient device exists yet. */
export async function encryptFor(token: string, peerId: string, plaintext: string): Promise<string | null> {
  const myId = ownUserId();
  const myDevice = getDeviceId();
  const uids = myId && myId !== peerId ? [peerId, myId] : [peerId];
  const buf = new TextEncoder().encode(plaintext).buffer;
  const r: Record<string, { t: number; b: string }> = {};
  for (const uid of uids) {
    let bundles: Bundle[];
    try {
      bundles = await api.getPrekeyBundles(token, uid);
    } catch {
      bundles = [];
    }
    for (const b of bundles) {
      if (uid === myId && b.device_id === myDevice) continue; // never to ourselves
      const addr = new SignalProtocolAddress(uid, b.device_id);
      if (!(await ensureSession(addr, b))) continue;
      const msg = await new SessionCipher(store, addr).encrypt(buf);
      r[`${uid}.${b.device_id}`] = { t: msg.type, b: btoa(msg.body as string) };
    }
  }
  if (Object.keys(r).length === 0) return null;
  return `sig2.${btoa(JSON.stringify({ s: myDevice, r }))}`;
}

/** Decrypt a Signal envelope addressed to this device, or null if it isn't ours /
 *  can't be decrypted. Handles multi-device `sig2.` and legacy single-device `sig1.`. */
export async function decryptFrom(senderUserId: string, wire: string): Promise<string | null> {
  if (wire.startsWith("sig2.")) {
    let env: { s: number; r: Record<string, { t: number; b: string }> };
    try {
      env = JSON.parse(atob(wire.slice(5)));
    } catch {
      return null;
    }
    const myId = ownUserId();
    const entry = myId ? env.r?.[`${myId}.${getDeviceId()}`] : undefined;
    if (!entry) return null; // not addressed to this device
    const cipher = new SessionCipher(store, new SignalProtocolAddress(senderUserId, env.s));
    try {
      const body = atob(entry.b);
      const pt =
        entry.t === 3
          ? await cipher.decryptPreKeyWhisperMessage(body, "binary")
          : await cipher.decryptWhisperMessage(body, "binary");
      return new TextDecoder().decode(new Uint8Array(pt));
    } catch {
      return null;
    }
  }
  // Legacy single-device sig1 fallback.
  const m = ENVELOPE.exec(wire);
  if (!m) return null;
  const cipher = new SessionCipher(store, new SignalProtocolAddress(senderUserId, LEGACY_DEVICE));
  try {
    const body = atob(m[2]);
    const type = parseInt(m[1], 10);
    const pt =
      type === 3
        ? await cipher.decryptPreKeyWhisperMessage(body, "binary")
        : await cipher.decryptWhisperMessage(body, "binary");
    return new TextDecoder().decode(new Uint8Array(pt));
  } catch {
    return null;
  }
}

// ── Safety number (identity fingerprint) ───────────────────────────────────────
// Same construction as Signal's displayable fingerprint (iterated SHA-512 over a
// version tag + identity key + identifier, encoded as 5-digit chunks), but computed
// with the browser's NATIVE crypto.subtle. The library's FingerprintGenerator routes
// through bundled msrcrypto whose worker-backed digest never settles under Vite.
const FP_VERSION = new Uint16Array([0]).buffer; // 2-byte LE version 0
const FP_ITERATIONS = 1024;

function concatAB(bufs: ArrayBuffer[]): ArrayBuffer {
  const total = bufs.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of bufs) {
    out.set(new Uint8Array(b), off);
    off += b.byteLength;
  }
  return out.buffer;
}

async function iterateHash(data: ArrayBuffer, key: ArrayBuffer, count: number): Promise<ArrayBuffer> {
  let acc = data;
  for (let i = 0; i < count; i++) acc = await crypto.subtle.digest("SHA-512", concatAB([acc, key]));
  return acc;
}

function encodeChunk(h: Uint8Array, off: number): string {
  const chunk =
    (h[off] * 2 ** 32 + h[off + 1] * 2 ** 24 + h[off + 2] * 2 ** 16 + h[off + 3] * 2 ** 8 + h[off + 4]) % 100000;
  return chunk.toString().padStart(5, "0");
}

async function displayFor(id: string, key: ArrayBuffer): Promise<string> {
  const bytes = concatAB([FP_VERSION, key, new TextEncoder().encode(id).buffer]);
  const hash = new Uint8Array(await iterateHash(bytes, key, FP_ITERATIONS));
  return [0, 5, 10, 15, 20, 25].map((o) => encodeChunk(hash, o)).join("");
}

// Load any stored identity key for a user (identities are keyed by full address
// "user.device"). Picks the lowest device id for determinism. With multiple peer
// devices the safety number covers one of them; cross-device aggregation is a
// follow-up — the single-device case (the common one) verifies exactly.
function loadAnyIdentity(userId: string): ArrayBuffer | undefined {
  const prefix = NS + "identity" + userId + ".";
  const keys = backend.keys().filter((k) => k.startsWith(prefix)).sort();
  if (!keys.length) return undefined;
  const s = backend.getItem(keys[0]);
  return s ? (dec(s) as ArrayBuffer) : undefined;
}

/** Safety number (identity fingerprint) for verifying a peer out-of-band; needs a
 *  session to already exist (so the peer's identity key is known). Both peers derive
 *  the same 60-digit value (the two display strings are sorted before joining). */
export async function safetyNumber(myId: string, peerId: string): Promise<string | null> {
  const mine = await store.getIdentityKeyPair();
  const theirs = loadAnyIdentity(peerId);
  if (!mine || !theirs) return null;
  const [local, remote] = await Promise.all([displayFor(myId, mine.pubKey), displayFor(peerId, theirs)]);
  return [local, remote].sort().join("");
}
