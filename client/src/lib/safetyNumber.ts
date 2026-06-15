// Pure safety-number (identity fingerprint) computation, extracted from signal.ts so
// the multi-device aggregation is unit-testable without importing libsignal.
//
// This is Signal's displayable-fingerprint construction (version tag + identity key +
// identifier, iterated SHA-512, encoded as 5-digit chunks) computed with the browser's
// NATIVE crypto.subtle — the library's FingerprintGenerator routes through bundled
// msrcrypto whose worker-backed digest never settles under Vite.
//
// Multi-device aggregation: a user can have several devices, each with its own identity
// key. We fold ALL of a user's device keys into one "combined identity" (deduped, sorted
// by bytes, concatenated) before fingerprinting, so verifying a contact once covers every
// device they use — not just the lowest-id one.

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

/** Byte-wise comparison of two identity keys, for deterministic ordering. */
export function compareKeys(a: ArrayBuffer, b: ArrayBuffer): number {
  const ua = new Uint8Array(a);
  const ub = new Uint8Array(b);
  const n = Math.min(ua.length, ub.length);
  for (let i = 0; i < n; i++) {
    if (ua[i] !== ub[i]) return ua[i] - ub[i];
  }
  return ua.length - ub.length;
}

/** Fold a user's device identity keys into one combined identity: deduped, sorted by
 *  bytes, then length-prefixed and concatenated. Order-independent (so both parties
 *  derive the same value) and the 4-byte length prefix makes it impossible for two
 *  different key sets to collide into the same byte string, whatever the key length. */
export function combinedIdentity(keys: ArrayBuffer[]): ArrayBuffer {
  const sorted = [...keys].sort(compareKeys);
  const deduped: ArrayBuffer[] = [];
  for (const k of sorted) {
    if (!deduped.length || compareKeys(deduped[deduped.length - 1], k) !== 0) deduped.push(k);
  }
  const parts: ArrayBuffer[] = [];
  for (const k of deduped) {
    const len = new ArrayBuffer(4);
    new DataView(len).setUint32(0, k.byteLength, false); // 4-byte big-endian length
    parts.push(len, k);
  }
  return concatAB(parts);
}

/** The 30-digit displayable fingerprint of one (id, combined-key) pair. */
export async function displayFingerprint(id: string, key: ArrayBuffer): Promise<string> {
  const bytes = concatAB([FP_VERSION, key, new TextEncoder().encode(id).buffer]);
  const hash = new Uint8Array(await iterateHash(bytes, key, FP_ITERATIONS));
  return [0, 5, 10, 15, 20, 25].map((o) => encodeChunk(hash, o)).join("");
}

/** The 60-digit safety number: each side's combined-device fingerprint, sorted then
 *  joined (so both peers derive the same value regardless of who is "local"). Returns
 *  null if either side has no known identity key. */
export async function computeSafetyNumber(
  myId: string,
  myKeys: ArrayBuffer[],
  peerId: string,
  peerKeys: ArrayBuffer[],
): Promise<string | null> {
  if (!myKeys.length || !peerKeys.length) return null;
  const [local, remote] = await Promise.all([
    displayFingerprint(myId, combinedIdentity(myKeys)),
    displayFingerprint(peerId, combinedIdentity(peerKeys)),
  ]);
  return [local, remote].sort().join("");
}
