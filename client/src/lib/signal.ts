// Signal Protocol engine — forward-secret, async (X3DH) sessions + Double Ratchet,
// via @privacyresearch/libsignal-protocol-typescript (a maintained TS port — no
// hand-rolled crypto). Private keys + ratchet state live only on this device
// (localStorage); the server holds public prekeys + ciphertext. Invisible to users.

import {
  KeyHelper,
  SignalProtocolAddress,
  SessionBuilder,
  SessionCipher,
  FingerprintGenerator,
} from "@privacyresearch/libsignal-protocol-typescript";
import { api } from "../api";

const NS = "kc:sig:";
const PREKEY_BATCH = 100;
const PREKEY_LOW = 20;
const ENVELOPE = /^sig1\.(\d)\.([\s\S]+)$/;
const DEVICE = 1; // single-device for v1

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

  async isTrustedIdentity(id: string, key: ArrayBuffer) {
    const t = this.get("identity" + id) as ArrayBuffer | undefined;
    return t === undefined ? true : ab2b64(key) === ab2b64(t);
  }
  async loadIdentityKey(id: string) {
    return this.get("identity" + id) as ArrayBuffer | undefined;
  }
  async saveIdentity(id: string, key: ArrayBuffer) {
    const name = SignalProtocolAddress.fromString(id).getName();
    const e = this.get("identity" + name) as ArrayBuffer | undefined;
    this.put("identity" + name, key);
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

/** Generate this device's identity + prekeys on first run + publish; replenish
 *  one-time prekeys when low. Safe to call on every login. */
export async function initSignal(token: string): Promise<void> {
  if (!(await store.getIdentityKeyPair())) {
    const idKP = await KeyHelper.generateIdentityKeyPair();
    const regId = await KeyHelper.generateRegistrationId();
    store.setOwnIdentity(idKP, regId);
    await publish(token);
  } else {
    try {
      const { count } = await api.signalPrekeyCount(token);
      if (count < PREKEY_LOW) await publish(token);
    } catch {
      /* offline — not critical */
    }
  }
}

// Fresh signed prekey + a batch of one-time prekeys → store + publish.
async function publish(token: string): Promise<void> {
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

/** Is stored content a Signal ciphertext envelope? */
export function isSignalCiphertext(s: string): boolean {
  return s.startsWith("sig1.");
}

/** Encrypt for a peer (X3DH session built on first contact). Returns `sig1.<t>.<b64>`,
 *  or null if the peer hasn't set up Signal yet. */
export async function encryptFor(token: string, peerId: string, plaintext: string): Promise<string | null> {
  const addr = new SignalProtocolAddress(peerId, DEVICE);
  if (!(await store.loadSession(addr.toString()))) {
    let bundle: Awaited<ReturnType<typeof api.getPrekeyBundle>>;
    try {
      bundle = await api.getPrekeyBundle(token, peerId);
    } catch {
      return null;
    }
    const pre = {
      identityKey: b642ab(bundle.identity_key),
      registrationId: bundle.registration_id,
      signedPreKey: {
        keyId: bundle.signed_prekey.key_id,
        publicKey: b642ab(bundle.signed_prekey.public_key),
        signature: b642ab(bundle.signed_prekey.signature),
      },
      ...(bundle.one_time_prekey
        ? {
            preKey: {
              keyId: bundle.one_time_prekey.key_id,
              publicKey: b642ab(bundle.one_time_prekey.public_key),
            },
          }
        : {}),
    };
    await new SessionBuilder(store, addr).processPreKey(pre);
  }
  const msg = await new SessionCipher(store, addr).encrypt(new TextEncoder().encode(plaintext).buffer);
  return `sig1.${msg.type}.${btoa(msg.body as string)}`;
}

/** Decrypt a `sig1.…` envelope, or null if it isn't ours / can't be decrypted. */
export async function decryptFrom(peerId: string, wire: string): Promise<string | null> {
  const m = ENVELOPE.exec(wire);
  if (!m) return null;
  const type = parseInt(m[1], 10);
  const body = atob(m[2]);
  const cipher = new SessionCipher(store, new SignalProtocolAddress(peerId, DEVICE));
  try {
    const pt =
      type === 3
        ? await cipher.decryptPreKeyWhisperMessage(body, "binary")
        : await cipher.decryptWhisperMessage(body, "binary");
    return new TextDecoder().decode(new Uint8Array(pt));
  } catch {
    return null;
  }
}

/** Safety number (identity fingerprint) for verifying a peer out-of-band; needs a
 *  session to already exist (so the peer's identity key is known). */
export async function safetyNumber(myId: string, peerId: string): Promise<string | null> {
  const mine = await store.getIdentityKeyPair();
  const theirs = await store.loadIdentityKey(peerId);
  if (!mine || !theirs) return null;
  return new FingerprintGenerator(1024).createFor(myId, mine.pubKey, peerId, theirs);
}
