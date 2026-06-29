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
import { recordKeySeen, setIdentityTrustBackend } from "./identityTrust";
import { computeSafetyNumber } from "./safetyNumber";

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
  // Keep the identity-change/verification flags in the SAME store as the keys
  // they guard (the locked-RAM vault on desktop).
  setIdentityTrustBackend(b);
}

/** A peer identity is stored per full address ("user.device"); strip the trailing
 *  device id to get the user id. User ids are UUIDs (hyphens, never dots), so the
 *  last dot is always the device separator. */
function userOf(address: string): string {
  const i = address.lastIndexOf(".");
  return i === -1 ? address : address.slice(0, i);
}

/** User ids are UUIDs — hyphens, never dots; the address separator is ".". Reject a
 *  dotted id so a malicious server can't smuggle one (e.g. "uuid.9") that would make
 *  userOf split on the wrong dot and bucket the identity-change flag under a phantom
 *  user, silently suppressing the real peer's "safety number changed" warning. */
function isValidUserId(id: string): boolean {
  return id.length > 0 && !id.includes(".");
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
  private readonly storage: SignalBackend | null;
  private readonly reportIdentityChanges: boolean;

  constructor(storage: SignalBackend | null = null, reportIdentityChanges = true) {
    this.storage = storage;
    this.reportIdentityChanges = reportIdentityChanges;
  }

  private activeBackend(): SignalBackend {
    return this.storage ?? backend;
  }

  private get(key: string): unknown {
    const s = this.activeBackend().getItem(NS + key);
    return s === null ? undefined : dec(s);
  }
  private put(key: string, v: unknown) {
    this.activeBackend().setItem(NS + key, enc(v));
  }
  private del(key: string) {
    this.activeBackend().removeItem(NS + key);
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
    //
    // We never BLOCK here (returning false would throw mid-decrypt) — instead the key
    // change is surfaced non-destructively: saveIdentity records it (see recordKeySeen)
    // and the UI shows a "safety number changed" banner. One consequence of not
    // blocking: because a reused session skips processPreKey, a swapped key is detected
    // on the INBOUND path (the attacker's first PreKeyWhisperMessage calls saveIdentity),
    // so the warning can arrive one message late rather than pre-empting the first read.
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
    // Record the change so the UI can warn ("safety number changed"); a key we've
    // never seen is trust-on-first-use, not a change. Returns the same boolean the
    // library expects (true iff a known key was replaced).
    if (!this.reportIdentityChanges) return Boolean(e && ab2b64(e) !== ab2b64(key));
    return recordKeySeen(userOf(id), e ? ab2b64(e) : undefined, ab2b64(key));
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
    const active = this.activeBackend();
    for (const k of active.keys()) if (k.startsWith(NS + "session" + prefix)) active.removeItem(k);
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

export type SignalCiphertextHeader = {
  version: "sig2" | "sig1";
  sender_device_id: number | null;
  recipient_count: number | null;
};

/** Parse non-secret Signal envelope metadata for recovery inventory. This does not
 * decrypt content or inspect ratchet state; it only lets the recovery UI say “we saw
 * Signal 1:1 ciphertext here, but manifest coverage is unavailable for that class.” */
export function parseSignalCiphertextHeader(wire: string): SignalCiphertextHeader | null {
  if (wire.startsWith("sig2.")) {
    try {
      const env = JSON.parse(atob(wire.slice(5))) as { s?: unknown; r?: unknown };
      return {
        version: "sig2",
        sender_device_id: typeof env.s === "number" ? env.s : null,
        recipient_count: env.r && typeof env.r === "object" ? Object.keys(env.r).length : null,
      };
    } catch {
      return null;
    }
  }
  return ENVELOPE.test(wire)
    ? { version: "sig1", sender_device_id: LEGACY_DEVICE, recipient_count: 1 }
    : null;
}

export type SignalRestorePreview = "restorable" | "missing_session" | "not_addressed" | "corrupt" | "unavailable";

function materialBackend(material: Record<string, string>): SignalBackend {
  const map = new Map(Object.entries(material).filter(([key]) => key.startsWith(NS)));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
    keys: () => [...map.keys()],
  };
}

/**
 * Try a Signal decrypt against a cloned backup snapshot, never the live Signal store.
 * A real decrypt is stronger than manifest guessing for Double Ratchet state, but it
 * advances only the temporary clone, so preview cannot consume the user's live ratchet.
 */
export async function previewSignalRestoreFromMaterial(
  material: Record<string, string>,
  senderUserId: string,
  wire: string,
): Promise<SignalRestorePreview> {
  if (!isValidUserId(senderUserId)) return "corrupt";
  const cloned = new SignalStore(materialBackend(material), false);
  try {
    if (wire.startsWith("sig2.")) {
      const env = JSON.parse(atob(wire.slice(5))) as { s?: unknown; r?: Record<string, { t: number; b: string }> };
      if (typeof env.s !== "number" || !env.r || typeof env.r !== "object") return "corrupt";
      const myId = material[NS + "ownUserId"];
      const myDevice = Number.parseInt(material[NS + "deviceId"] ?? "", 10);
      if (!myId || !Number.isFinite(myDevice)) return "unavailable";
      const entry = env.r[`${myId}.${myDevice}`];
      if (!entry) return "not_addressed";
      if (!(await cloned.loadSession(`${senderUserId}.${env.s}`))) return "missing_session";
      const cipher = new SessionCipher(cloned, new SignalProtocolAddress(senderUserId, env.s));
      const body = atob(entry.b);
      if (entry.t === 3) await cipher.decryptPreKeyWhisperMessage(body, "binary");
      else await cipher.decryptWhisperMessage(body, "binary");
      return "restorable";
    }
    const legacy = ENVELOPE.exec(wire);
    if (!legacy) return "corrupt";
    if (!(await cloned.loadSession(`${senderUserId}.${LEGACY_DEVICE}`))) return "missing_session";
    const cipher = new SessionCipher(cloned, new SignalProtocolAddress(senderUserId, LEGACY_DEVICE));
    const body = atob(legacy[2]);
    if (legacy[1] === "3") await cipher.decryptPreKeyWhisperMessage(body, "binary");
    else await cipher.decryptWhisperMessage(body, "binary");
    return "restorable";
  } catch {
    return "corrupt";
  }
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
  if (!isValidUserId(peerId)) return null;
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
  // A legit sender id is a dot-free UUID; reject anything else so a hostile server
  // can't mis-bucket the identity-change flag under a phantom user (see isValidUserId).
  if (!isValidUserId(senderUserId)) return null;
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
// Load ALL stored identity keys for a user (identities are keyed by full address
// "user.device", so this returns one per device we've seen). Used to aggregate a
// contact's devices into one safety number.
function loadAllIdentities(userId: string): ArrayBuffer[] {
  const prefix = NS + "identity" + userId + ".";
  return backend
    .keys()
    .filter((k) => k.startsWith(prefix))
    .sort()
    .map((k) => backend.getItem(k))
    .filter((s): s is string => s !== null && s !== "")
    .map((s) => dec(s) as ArrayBuffer);
}

// Fetch a user's full device identity-key set from the directory (no prekey pop). The
// directory is untrusted — but the safety number is compared OUT OF BAND, so a server
// that lies about a user's devices produces a mismatch the two parties will notice.
async function fetchIdentityKeys(token: string, userId: string): Promise<ArrayBuffer[]> {
  try {
    const rows = await api.getIdentityKeys(token, userId);
    return rows.map((r) => b642ab(r.identity_key));
  } catch {
    return [];
  }
}

/** Safety number (identity fingerprint) for verifying a peer out-of-band. Aggregates
 *  EVERY device key on each side — fetched from the server directory so it covers
 *  devices this client hasn't yet messaged — so verifying a contact once covers all
 *  their devices. Falls back to locally-seen keys when offline. Both peers derive the
 *  same 60-digit value. */
export async function safetyNumber(token: string, myId: string, peerId: string): Promise<string | null> {
  if (!isValidUserId(myId) || !isValidUserId(peerId)) return null;
  const mine = await store.getIdentityKeyPair();
  if (!mine) return null;
  // Prefer the server's full directory; fall back to locally-seen keys when offline.
  const peerServer = await fetchIdentityKeys(token, peerId);
  const theirKeys = peerServer.length ? peerServer : loadAllIdentities(peerId);
  const myServer = await fetchIdentityKeys(token, myId);
  // combinedIdentity dedupes, so including our current device's key alongside the
  // directory copy is harmless.
  const myKeys = [mine.pubKey, ...(myServer.length ? myServer : loadAllIdentities(myId))];
  return computeSafetyNumber(myId, myKeys, peerId, theirKeys);
}
