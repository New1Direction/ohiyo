// Encrypted recovery backup — recovery-code model (self-custody).
//
// We generate a high-entropy recovery code for the user. From it we derive an
// AES-256 key (PBKDF2, native crypto.subtle) and wrap the device's E2E key
// material; only that ciphertext is uploaded. The server is a dumb store — it
// never sees the code or the keys. To restore on a new device the user enters
// the code, we fetch the blob, unwrap, and write the keys back.
//
// No hand-rolled crypto: PBKDF2 + AES-GCM via the Web Crypto API. No new deps.

// Unambiguous alphabet (no 0/O/1/I/L) for codes a human can transcribe.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LEN = 24; // ~118 bits of entropy
const PBKDF2_ITERS = 210_000;

function b64(buf: ArrayBuffer): string {
  const u = new Uint8Array(buf);
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s);
}
function b64d(s: string): ArrayBuffer {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
}

/** Uniform random index in [0, max) via rejection sampling (no modulo bias). */
function randIndex(max: number): number {
  const limit = 256 - (256 % max);
  const b = new Uint8Array(1);
  do {
    crypto.getRandomValues(b);
  } while (b[0] >= limit);
  return b[0] % max;
}

/** A fresh recovery code, grouped for readability: "ABCDE-FGHJK-...". */
export function generateRecoveryCode(): string {
  let s = "";
  for (let i = 0; i < CODE_LEN; i++) s += ALPHABET[randIndex(ALPHABET.length)];
  return (s.match(/.{1,5}/g) ?? [s]).join("-");
}

/** Strip formatting (case, dashes, spaces) so entry is forgiving. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export type BackupBlob = { v: 1; salt: string; iv: string; ct: string };

async function deriveKey(code: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = new TextEncoder().encode(normalizeRecoveryCode(code));
  const baseKey = await crypto.subtle.importKey("raw", material, "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Wrap key material under a recovery code. Returns an opaque, uploadable blob. */
export async function encryptBackup(code: string, material: Record<string, string>): Promise<BackupBlob> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(code, salt);
  const pt = new TextEncoder().encode(JSON.stringify(material));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt);
  return { v: 1, salt: b64(salt.buffer), iv: b64(iv.buffer), ct: b64(ct) };
}

/** Unwrap a backup blob with the recovery code. Throws if the code is wrong or
 *  the blob is tampered (AES-GCM auth failure). */
export async function decryptBackup(code: string, blob: BackupBlob): Promise<Record<string, string>> {
  const salt = new Uint8Array(b64d(blob.salt));
  const iv = new Uint8Array(b64d(blob.iv));
  const key = await deriveKey(code, salt);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, b64d(blob.ct));
  return JSON.parse(new TextDecoder().decode(pt)) as Record<string, string>;
}
