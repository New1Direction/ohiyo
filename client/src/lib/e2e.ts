// End-to-end encryption primitives (Web Crypto) — the foundation for encrypted DMs,
// a thing the incumbents don't do. v1: ECDH P-256 key agreement + AES-GCM message
// encryption. The server only ever stores ciphertext + public keys; private keys
// never leave the device.
//
// This module is the crypto core. Wiring it into the DM send/receive flow (so the
// server can't read DM content) builds on top of these primitives.

const KEY_STORAGE = "kc:e2e-keypair";

// Pluggable storage so the desktop locked-RAM vault can hold the keypair instead of
// plaintext localStorage (the web build keeps the localStorage default).
type KeyStore = { getItem(k: string): string | null; setItem(k: string, v: string): void };
let store: KeyStore = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
};
export function setE2eStore(s: KeyStore) {
  store = s;
}

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
  const raw = store.getItem(KEY_STORAGE);
  if (raw) {
    try {
      return JSON.parse(raw) as StoredKeyPair;
    } catch {
      /* corrupt — regenerate below */
    }
  }
  const kp = await generateKeyPair();
  store.setItem(KEY_STORAGE, JSON.stringify(kp));
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

// "v1." messages (the first, static-key format, sent for one day in June 2026) are no
// longer opened or written: their key came from a public key the server handed out, with
// nothing to check it against, so a server could forge one. A v1 message is still
// recognised below, so it shows as unreadable rather than as raw text.

/** True if a stored message looks like our E2E ciphertext envelope. */
export function isEncrypted(payload: string): boolean {
  return /^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/.test(payload);
}
