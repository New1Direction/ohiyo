// When a chat enters encrypted mode, and who a 1:1 chat encrypts to. Fails closed: in a
// DM or group DM, a well-formed ciphertext envelope (or a message that decrypted here)
// switches the chat to encrypted mode, so a participant who can't decrypt still replies
// encrypted. A server channel never switches, and content that merely starts with an
// envelope prefix changes nothing. Pure (no React, storage or network) for unit tests.
import type { Channel } from "../api";

type ChannelType = Channel["channel_type"];

const isDirectChat = (t: ChannelType | undefined): boolean => t === "dm" || t === "group_dm";

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const isB64 = (v: unknown): v is string => typeof v === "string" && v.length % 4 === 0 && B64.test(v);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function parseB64Json(body: string): unknown {
  if (!isB64(body)) return null;
  try {
    const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

// grp1.<b64 json {kid, it, ct, sig, ep?, iv?}> — see senderKeys.ts groupEncryptInner.
function isGroupEnvelope(body: string): boolean {
  const env = parseB64Json(body);
  if (!isRecord(env)) return false;
  return (
    Number.isSafeInteger(env.kid) &&
    Number.isSafeInteger(env.it) &&
    (env.it as number) >= 0 &&
    isB64(env.ct) &&
    isB64(env.sig) &&
    (env.ep === undefined || Number.isSafeInteger(env.ep)) &&
    (env.iv === undefined || isB64(env.iv))
  );
}

// sig2.<b64 json {s: senderDevice, r: {"user.device": {t: 1|3, b: b64}}}> — see signal.ts encryptFor.
function isSignalEnvelope(body: string): boolean {
  const env = parseB64Json(body);
  if (!isRecord(env) || !Number.isSafeInteger(env.s) || !isRecord(env.r)) return false;
  const entries = Object.entries(env.r);
  return (
    entries.length > 0 &&
    entries.every(
      ([addr, e]) => /^[^.]+\.\d+$/.test(addr) && isRecord(e) && (e.t === 1 || e.t === 3) && isB64(e.b),
    )
  );
}

/** Does `content` parse as a real sig2 / sig1 / grp1 ciphertext envelope (not merely
 *  start with the prefix)? Says nothing about whether this device can decrypt it. */
export function isWellFormedEnvelope(content: string): boolean {
  if (content.startsWith("grp1.")) return isGroupEnvelope(content.slice(5));
  if (content.startsWith("sig2.")) return isSignalEnvelope(content.slice(5));
  const legacy = /^sig1\.([13])\.(.+)$/s.exec(content);
  return legacy !== null && isB64(legacy[2]);
}

/** Should a chat of `channelType` enter encrypted mode, given its messages' contents and
 *  whether any of them decrypted on this device? */
export function shouldEnterEncryptedMode(
  channelType: ChannelType | undefined,
  contents: readonly string[],
  decryptedAny: boolean,
): boolean {
  if (!isDirectChat(channelType)) return false;
  return decryptedAny || contents.some(isWellFormedEnvelope);
}

/** Should this message go into the (bounded) recovery inventory? Only a well-formed
 *  envelope, and only in a DM or group DM — a server channel's content must not be able
 *  to evict real entries. */
export function shouldRecordRecoveryInventory(channelType: ChannelType | undefined, content: string): boolean {
  return isDirectChat(channelType) && isWellFormedEnvelope(content);
}

/** The peer of a 1:1 chat: the single participant who isn't me. Undefined when that
 *  isn't exactly one person or I don't know who I am. */
export function pickDmPeer(participants: readonly { id: string }[], myId: string | undefined): string | undefined {
  if (!myId) return undefined;
  const others = participants.filter((p) => p.id !== myId);
  return others.length === 1 ? others[0].id : undefined;
}

/** The peer of a 1:1 chat: the one already known, else learned from the chat's
 *  participant list (after a reload nothing is known yet when the loaded page has no
 *  ciphertext). Undefined when it can't be learned (offline, or not exactly one other
 *  person). */
export async function resolveDmPeer(
  known: string | undefined,
  listParticipants: () => Promise<readonly { id: string }[]>,
  myId: string | undefined,
): Promise<string | undefined> {
  if (known) return known;
  try {
    return pickDmPeer(await listParticipants(), myId);
  } catch {
    return undefined;
  }
}

/** Drop stored encrypted-mode entries for channels positively known to be server
 *  channels (earlier builds could mark one). DMs, group DMs and ids we don't recognise
 *  are kept. Returns `stored` itself when nothing changes. */
export function withoutServerChannels(
  stored: ReadonlySet<string>,
  channels: readonly { id: string; channel_type: ChannelType }[],
): ReadonlySet<string> {
  const server = new Set(channels.filter((c) => !isDirectChat(c.channel_type)).map((c) => c.id));
  if (![...stored].some((id) => server.has(id))) return stored;
  return new Set([...stored].filter((id) => !server.has(id)));
}

/** The channels worth scanning for recovery inventory: DMs and group DMs, the only ones
 *  whose messages can ever be recorded. */
export function recoveryScanChannels<C extends { channel_type: ChannelType }>(channels: readonly C[]): C[] {
  return channels.filter((c) => isDirectChat(c.channel_type));
}

/** The messages of a channel to record in the recovery inventory (see
 *  shouldRecordRecoveryInventory). */
export function recoverableMessages<M extends { content: string }>(channelType: ChannelType | undefined, messages: readonly M[]): M[] {
  return messages.filter((m) => shouldRecordRecoveryInventory(channelType, m.content));
}
