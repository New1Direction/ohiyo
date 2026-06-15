// End-to-end encryption primitives (Web Crypto) — the foundation for encrypted DMs,
// a thing the incumbents don't do. v1: ECDH P-256 key agreement + AES-GCM message
// encryption. The server only ever stores ciphertext + public keys; private keys
// never leave the device.
//
// This module is the crypto core. Wiring it into the DM send/receive flow (so the
// server can't read DM content) builds on top of these primitives.

const KEY_STORAGE = "kc:e2e-keypair";

export type StoredKeyPair = { publicJwk: JsonWebKey; privateJwk: JsonWebKey };

/** Generate a fresh ECDH P-256 keypair, exported as JWK for storage/transmission. */
export async function generateKeyPair(): Promise<StoredKeyPair> {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveKey",
  ]);
  const publicJwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  return { publicJwk, privateJwk };
}

/** Load this device's keypair, generating + persisting one on first use. */
export async function myKeyPair(): Promise<StoredKeyPair> {
  const raw = localStorage.getItem(KEY_STORAGE);
  if (raw) {
    try {
      return JSON.parse(raw) as StoredKeyPair;
    } catch {
      /* corrupt — regenerate below */
    }
  }
  const kp = await generateKeyPair();
  localStorage.setItem(KEY_STORAGE, JSON.stringify(kp));
  return kp;
}

async function importPrivate(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, [
    "deriveKey",
  ]);
}

async function importPublic(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
}

/** Derive a shared AES-GCM key from my private + their public key (ECDH agreement). */
export async function deriveSharedKey(
  myPrivateJwk: JsonWebKey,
  theirPublicJwk: JsonWebKey
): Promise<CryptoKey> {
  const priv = await importPrivate(myPrivateJwk);
  const pub = await importPublic(theirPublicJwk);
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: pub },
    priv,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/** Encrypt plaintext → "v1.<iv_b64>.<ciphertext_b64>" (random 96-bit IV per message). */
export async function encryptMessage(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  return `v1.${toB64(iv)}.${toB64(ct)}`;
}

/** Decrypt a "v1.<iv>.<ct>" payload, or null if it isn't our format / auth fails. */
export async function decryptMessage(key: CryptoKey, payload: string): Promise<string | null> {
  const parts = payload.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  try {
    const iv = fromB64(parts[1]);
    const ct = fromB64(parts[2]);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return dec.decode(pt);
  } catch {
    return null;
  }
}

/** True if a stored message looks like our E2E ciphertext envelope. */
export function isEncrypted(payload: string): boolean {
  return /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(payload);
}
