// Group E2E via Sender Keys (the Signal/WhatsApp group scheme). Each member, per
// group, holds a "sender key": a 32-byte chain key that ratchets forward to derive a
// fresh message key per message, plus an ECDSA P-256 signing key so other members can
// verify a message really came from that member (a group peer can't forge another's).
//
// To send: derive the message key at the current iteration, AES-256-GCM encrypt, sign
// the ciphertext, then ratchet the chain forward. To receive: install the sender's
// Sender Key Distribution Message (chain key + verify key + iteration) — delivered
// out-of-band over the pairwise Signal sessions — ratchet to the message's iteration,
// verify the signature, decrypt.
//
// All primitives are the browser's NATIVE crypto.subtle (HMAC, HKDF, AES-GCM, ECDSA);
// only the protocol composition (the chain ratchet + distribution) is ours.

const NS = "kc:sk:";

// ── Pluggable storage (localStorage in the browser; injectable for tests) ───────
export type SenderKeyBackend = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
};
let backend: SenderKeyBackend = {
  getItem: (k) => localStorage.getItem(k),
  setItem: (k, v) => localStorage.setItem(k, v),
};
export function setSenderKeyBackend(b: SenderKeyBackend) {
  backend = b;
}

const b64 = (ab: ArrayBuffer): string => {
  const u = new Uint8Array(ab);
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s);
};
const unb64 = (s: string): ArrayBuffer => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;
const te = new TextEncoder();
const td = new TextDecoder();

// ── Chain ratchet + key derivation (Signal sender-key construction) ─────────────
async function hmac(key: ArrayBuffer, msg: Uint8Array): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, msg);
}
// messageKey = HMAC(chainKey, 0x01);  nextChainKey = HMAC(chainKey, 0x02)
const messageKeyOf = (ck: ArrayBuffer) => hmac(ck, new Uint8Array([0x01]));
const nextChainOf = (ck: ArrayBuffer) => hmac(ck, new Uint8Array([0x02]));

// message key → AES-256-GCM key (+ a deterministic 12-byte IV kept ONLY for decrypting
// legacy envelopes that predate the random-IV format). New messages carry a random IV in
// the envelope instead (see groupEncryptInner), so the (key, IV) pair stays unique even if
// the same chain iteration is ever encrypted twice — e.g. two tabs/windows sharing the
// persisted chain key, which per-context serialization alone cannot prevent.
async function deriveAes(messageKey: ArrayBuffer): Promise<{ key: CryptoKey; iv: Uint8Array }> {
  const base = await crypto.subtle.importKey("raw", messageKey, "HKDF", false, ["deriveBits"]);
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode("kc-group-msg") },
      base,
      (32 + 12) * 8
    )
  );
  const key = await crypto.subtle.importKey("raw", bits.slice(0, 32), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
  return { key, iv: bits.slice(32, 44) };
}

const randomKeyId = () => Math.floor(Math.random() * 0x7fffffff);

// ── Persisted state ─────────────────────────────────────────────────────────────
// `epoch` ties a sender key to a membership generation. The server bumps a group's
// epoch on every add/remove; when ours advances we mint a brand-new chain (rotate),
// so a removed member's copy of the old chain — and any forward ratchet of it — is
// dead. Messages and peer keys carry their epoch; cross-epoch reads are rejected.
type OwnState = {
  keyId: number;
  chainKey: string;
  iteration: number;
  signPriv: JsonWebKey;
  verifyKey: string;
  epoch: number;
};
type PeerState = { keyId: number; chainKey: string; iteration: number; verifyKey: string; epoch: number };

const ownKey = (groupId: string) => `${NS}own:${groupId}`;
const peerKey = (groupId: string, userId: string) => `${NS}peer:${groupId}:${userId}`;
const epochKey = (groupId: string) => `${NS}epoch:${groupId}`;
const getJson = <T,>(k: string): T | null => {
  const s = backend.getItem(k);
  return s ? (JSON.parse(s) as T) : null;
};
const putJson = (k: string, v: unknown) => backend.setItem(k, JSON.stringify(v));

/** Is stored content a group sender-key ciphertext envelope? */
export function isGroupCiphertext(s: string): boolean {
  return s.startsWith("grp1.");
}

// ── Group epoch (membership generation) ─────────────────────────────────────────
/** The latest epoch we've learned for a group (from the server). Defaults to 0. */
export function getGroupEpoch(groupId: string): number {
  const n = Number.parseInt(backend.getItem(epochKey(groupId)) ?? "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
// Persist the known epoch, never decreasing (the server's epoch only goes up).
function rememberEpoch(groupId: string, epoch: number): void {
  if (epoch > getGroupEpoch(groupId)) backend.setItem(epochKey(groupId), String(epoch));
}

// Mint a fresh sender key (random chain + ECDSA signing pair + key id) at `epoch`,
// replacing any existing one. Used both for the first key and for rotation.
async function mintOwnSenderKey(groupId: string, epoch: number): Promise<OwnState> {
  const chainKey = b64(crypto.getRandomValues(new Uint8Array(32)).buffer);
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const signPriv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const verifyKey = b64(await crypto.subtle.exportKey("raw", pair.publicKey));
  const state: OwnState = { keyId: randomKeyId(), chainKey, iteration: 0, signPriv, verifyKey, epoch };
  putJson(ownKey(groupId), state);
  return state;
}

/**
 * Learn the group's current epoch. If it has advanced past our own sender key's
 * epoch (a member was added/removed), rotate: mint a fresh key at the new epoch and
 * return true so the caller re-distributes it to the *current* members. Returns
 * false when nothing rotated (same/older epoch, or we hold no key yet — the first
 * key will simply be minted at this epoch on demand).
 */
export async function setGroupEpoch(groupId: string, epoch: number): Promise<boolean> {
  rememberEpoch(groupId, epoch);
  const own = getJson<OwnState>(ownKey(groupId));
  if (own && getGroupEpoch(groupId) > (own.epoch ?? 0)) {
    await mintOwnSenderKey(groupId, getGroupEpoch(groupId));
    return true;
  }
  return false;
}

// Create (once) this member's sender key for a group, tagged with the group's
// current epoch so a member joining mid-life starts in the live generation.
async function ensureOwnSenderKey(groupId: string): Promise<OwnState> {
  const existing = getJson<OwnState>(ownKey(groupId));
  if (existing) return { ...existing, epoch: existing.epoch ?? 0 };
  return mintOwnSenderKey(groupId, getGroupEpoch(groupId));
}

/** The Sender Key Distribution Message for THIS member's current sender key in a group
 *  — a JSON string to be encrypted (pairwise) and sent to each other member, who then
 *  calls installDistribution(). Distributes the CURRENT chain key + iteration. */
export async function buildDistribution(groupId: string): Promise<string> {
  const s = await ensureOwnSenderKey(groupId);
  return JSON.stringify({ kid: s.keyId, ck: s.chainKey, it: s.iteration, vk: s.verifyKey, ep: s.epoch });
}

/** Install a peer's distributed sender key for a group (from a decrypted SKDM). */
export function installDistribution(groupId: string, fromUserId: string, skdmJson: string): void {
  const d = JSON.parse(skdmJson) as { kid: number; ck: string; it: number; vk: string; ep?: number };
  const incoming: PeerState = {
    keyId: d.kid,
    chainKey: d.ck,
    iteration: d.it,
    verifyKey: d.vk,
    epoch: d.ep ?? 0,
  };
  // SKDMs ride async pairwise sessions, so delivery can reorder — and a malicious server
  // can replay an old one. Refuse a distribution that would CLOBBER a newer chain with an
  // older one (which would make the peer's subsequent messages undecryptable). Accept a
  // newer epoch, a new key id (genuine re-distribution), or a forward iteration; reject a
  // same-key, same-epoch rewind and any older epoch.
  const existing = getJson<PeerState>(peerKey(groupId, fromUserId));
  if (existing) {
    if (incoming.epoch < (existing.epoch ?? 0)) return;
    if (
      incoming.epoch === (existing.epoch ?? 0) &&
      incoming.keyId === existing.keyId &&
      incoming.iteration < existing.iteration
    ) {
      return;
    }
  }
  putJson(peerKey(groupId, fromUserId), incoming);
}

// Per-group serialization for our own send ratchet. groupEncrypt is a read-modify-write
// on the chain key; two concurrent calls would both encrypt at the SAME iteration and so
// reuse the deterministic (AES-256-GCM key, IV) pair on different plaintexts — a
// catastrophic GCM failure (recoverable plaintext XOR + forgeable tags). Concurrency is
// real here: flushOutbox retries queued sends without awaiting. Chaining each group's
// encrypts makes the ratchet advance atomic before the next read.
const encryptChains = new Map<string, Promise<unknown>>();

/** Encrypt a message for the group with our sender key. Returns `grp1.<b64(json)>`,
 *  or null if we have no sender key yet (shouldn't happen after buildDistribution). */
export function groupEncrypt(groupId: string, plaintext: string): Promise<string | null> {
  const prev = encryptChains.get(groupId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(() => groupEncryptInner(groupId, plaintext));
  // Tail never rejects, so one failed send can't poison the chain or leak an unhandled
  // rejection; callers still get the real result (which may reject) via `run`.
  encryptChains.set(groupId, run.catch(() => {}));
  return run;
}

async function groupEncryptInner(groupId: string, plaintext: string): Promise<string | null> {
  const s = getJson<OwnState>(ownKey(groupId));
  if (!s) return null;
  const ck = unb64(s.chainKey);
  const mk = await messageKeyOf(ck);
  const { key } = await deriveAes(mk);
  // Random per-message IV, transmitted in the envelope. A deterministic IV meant a re-used
  // chain iteration → re-used (key, IV) pair — catastrophic for AES-GCM. Randomizing the IV
  // removes the nonce-uniqueness requirement, closing the cross-tab/-window reuse window.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(plaintext));
  const signKey = await crypto.subtle.importKey("jwk", s.signPriv, { name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signKey, ct);
  const envelope = { kid: s.keyId, it: s.iteration, ct: b64(ct), sig: b64(sig), ep: s.epoch ?? 0, iv: b64(iv.buffer) };
  // Ratchet forward (forward secrecy: this message key can't be re-derived).
  s.chainKey = b64(await nextChainOf(ck));
  s.iteration += 1;
  putJson(ownKey(groupId), s);
  return `grp1.${b64(te.encode(JSON.stringify(envelope)).buffer)}`;
}

/** Decrypt a group message from a member, verifying their signature. Ratchets that
 *  sender's chain forward to the message's iteration. Returns null if we don't hold
 *  the sender's key, the key id differs (rotated → needs redistribution), the message
 *  is older than our chain (already ratcheted past), or the signature fails. */
export async function groupDecrypt(groupId: string, fromUserId: string, wire: string): Promise<string | null> {
  if (!wire.startsWith("grp1.")) return null;
  const peer = getJson<PeerState>(peerKey(groupId, fromUserId));
  if (!peer) return null;
  let env: { kid: number; it: number; ct: string; sig: string; ep?: number; iv?: string };
  try {
    env = JSON.parse(td.decode(unb64(wire.slice(5))));
  } catch {
    return null;
  }
  // Epoch gate: only decrypt within the membership generation we hold this peer's key
  // for. A message from a newer epoch means the peer rekeyed and we await their fresh
  // SKDM; an older epoch is a generation we've rotated past. Either way → null.
  if ((env.ep ?? 0) !== (peer.epoch ?? 0)) return null;
  if (env.kid !== peer.keyId || env.it < peer.iteration) return null;
  // Ratchet this sender's chain forward to the message's iteration.
  let ck = unb64(peer.chainKey);
  for (let i = peer.iteration; i < env.it; i++) ck = await nextChainOf(ck);
  const mk = await messageKeyOf(ck);
  // Verify the sender's signature over the ciphertext before decrypting.
  const verifyKey = await crypto.subtle.importKey(
    "raw",
    unb64(peer.verifyKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  const ctBuf = unb64(env.ct);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifyKey, unb64(env.sig), ctBuf);
  if (!ok) return null;
  const derived = await deriveAes(mk);
  // New envelopes carry a random IV; legacy ones (no `iv`) used the deterministic one.
  const iv = env.iv ? new Uint8Array(unb64(env.iv)) : derived.iv;
  let plaintext: string;
  try {
    plaintext = td.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, derived.key, ctBuf));
  } catch {
    return null;
  }
  // Advance our stored view of this sender's chain past this message.
  peer.chainKey = b64(await nextChainOf(ck));
  peer.iteration = env.it + 1;
  putJson(peerKey(groupId, fromUserId), peer);
  return plaintext;
}

/** Forget all sender-key state for a group (e.g. on membership change → rotate). */
export function resetGroup(groupId: string): void {
  backend.setItem(ownKey(groupId), "");
}
