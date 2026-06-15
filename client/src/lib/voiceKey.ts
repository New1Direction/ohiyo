// Pure helpers for LiveKit voice/video E2EE shared-key distribution.
//
// The frame crypto itself is LiveKit's FrameCryptor (AES-GCM, run in the e2ee worker
// via ExternalE2EEKeyProvider — no hand-rolled media crypto). All we own is:
//   - generating the 32-byte room key,
//   - the convergence rule that makes every participant settle on ONE shared key
//     without a central coordinator, and
//   - (de)serializing the key into an envelope that rides the existing pairwise
//     Signal channel (encryptFor) so the server only ever relays ciphertext.
//
// Convergence model (gossip, no election round-trip): every participant announces ONLY
// its OWN key (so the envelope's source id always equals the authenticated sender — a
// participant can never announce a key "as" someone else). Each client collects the
// per-participant own-keys it has seen and uses the one from the smallest user id. A
// peer with a smaller id replies with its own key so newcomers learn it. Because the
// shared key is just "min over the collected set", dropping a participant's key when
// they leave the call rotates the key automatically (no epoch needed) — a departed
// member can't decrypt anything sent after their key is evicted.

const KEY_BYTES = 32;
export const VOICE_ENVELOPE_TAG = "vk1";

export type VoiceKeyEnvelope = { v: typeof VOICE_ENVELOPE_TAG; k: string; s: string };

/** A fresh 32-byte room key (CSPRNG). LiveKit runs HKDF over it internally. */
export function generateRoomKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

const b64 = (u: Uint8Array): string => {
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s);
};
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Serialize a room key + its originating user id for pairwise-encrypted relay. */
export function encodeVoiceEnvelope(key: Uint8Array, sourceId: string): string {
  return JSON.stringify({ v: VOICE_ENVELOPE_TAG, k: b64(key), s: sourceId } satisfies VoiceKeyEnvelope);
}

/** Parse a decrypted voice-key envelope, or null if it isn't one / is malformed. */
export function decodeVoiceEnvelope(json: string): { key: Uint8Array; sourceId: string } | null {
  let e: VoiceKeyEnvelope;
  try {
    e = JSON.parse(json) as VoiceKeyEnvelope;
  } catch {
    return null;
  }
  if (!e || e.v !== VOICE_ENVELOPE_TAG || typeof e.k !== "string" || typeof e.s !== "string") return null;
  let key: Uint8Array;
  try {
    key = unb64(e.k);
  } catch {
    return null;
  }
  if (key.length !== KEY_BYTES) return null;
  return { key, sourceId: e.s };
}

/** The canonical key among the per-participant own-keys collected so far: the one from
 *  the lexicographically smallest source id. Null if the set is empty. */
export function pickCanonical(keys: Map<string, Uint8Array>): { sourceId: string; key: Uint8Array } | null {
  let best: string | null = null;
  for (const sourceId of keys.keys()) {
    if (best === null || sourceId < best) best = sourceId;
  }
  return best === null ? null : { sourceId: best, key: keys.get(best)! };
}

/** True when a peer's announcement loses to our own key, so we reply with ours to pull
 *  the (higher-id) sender toward the canonical key. */
export function shouldReplyWithOurs(ourSourceId: string, incomingSourceId: string): boolean {
  return incomingSourceId > ourSourceId;
}
