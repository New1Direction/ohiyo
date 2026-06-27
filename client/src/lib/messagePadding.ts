// Client-side plaintext padding for encrypted user messages.
//
// The server must never see the real message length for encrypted chats if we can
// cheaply avoid it. We therefore encrypt a small authenticated wrapper whose random
// padding brings short/medium messages up to coarse buckets. This is deliberately
// bounded: padding a 3.5KB message past the server's 4KB message limit would create a
// reliability bug, so very large messages are left unwrapped rather than bloated.

const PREFIX = "\u001fOHIYO_PAD1.";
const BUCKETS = [128, 256, 512, 1024, 1536] as const;
const MAX_PADDED_BYTES = BUCKETS[BUCKETS.length - 1];

type PaddedMessage = {
  v: 1;
  t: string;
  p: string;
};

const te = new TextEncoder();
const td = new TextDecoder();

function byteLen(s: string): number {
  return te.encode(s).length;
}

function toB64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromB64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

function encodeWrapper(body: PaddedMessage): string {
  return `${PREFIX}${toB64Url(te.encode(JSON.stringify(body)))}`;
}

const PAD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function randomPadChars(charCount: number): string {
  if (charCount <= 0) return "";
  const bytes = new Uint8Array(charCount);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += PAD_ALPHABET[b & 63];
  return out;
}

function bucketFor(bytes: number): number | null {
  return BUCKETS.find((b) => bytes <= b) ?? null;
}

/**
 * Pad user-visible message text before encryption. Returns a wrapper that decrypts
 * back to the original text via `unpadMessagePlaintext`. Very large messages are
 * returned unchanged to avoid breaking the server's ciphertext size limit.
 */
export function padMessagePlaintext(text: string): string {
  const base = encodeWrapper({ v: 1, t: text, p: "" });
  const target = bucketFor(byteLen(base));
  if (!target || target > MAX_PADDED_BYTES) return text;

  // Choose a padding-string length that makes the *encoded wrapper* exactly hit the
  // bucket. `p` uses URL-safe ASCII, so each added char changes JSON byte length by 1
  // with no escaping surprises. The search is tiny (≤1536) and only runs before send.
  for (let padChars = 0; padChars <= MAX_PADDED_BYTES; padChars++) {
    const candidateLen = byteLen(encodeWrapper({ v: 1, t: text, p: "x".repeat(padChars) }));
    if (candidateLen === target) return encodeWrapper({ v: 1, t: text, p: randomPadChars(padChars) });
    if (candidateLen > target) break;
  }

  // Should not happen for the chosen buckets, but fail safe: readable encrypted text
  // beats a send failure.
  return base;
}

/**
 * Remove Ohiyo padding after decryption. Old ciphertexts and unwrapped plaintext are
 * returned unchanged for backwards compatibility.
 */
export function unpadMessagePlaintext(text: string): string {
  if (!text.startsWith(PREFIX)) return text;
  try {
    const raw = td.decode(fromB64Url(text.slice(PREFIX.length)));
    const parsed = JSON.parse(raw) as Partial<PaddedMessage>;
    if (parsed?.v !== 1 || typeof parsed.t !== "string" || typeof parsed.p !== "string") return text;
    return parsed.t;
  } catch {
    return text;
  }
}

export function paddedPlaintextLengthForTest(text: string): number {
  return byteLen(padMessagePlaintext(text));
}
