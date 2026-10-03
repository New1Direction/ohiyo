// What may leave this device for a chat in encrypted mode. Send, edit and retry all go
// through encryptOutgoing, which returns ciphertext or throws — never the plaintext —
// and never lets a group fall back to the one-to-one path. Kept free of React and the
// network so the rules are unit-testable.
import type { Channel } from "../api";

type ChannelType = Channel["channel_type"];

export type EncryptedSendFailure = "no-group-sender-key" | "no-signal-session" | "not-a-direct-chat";

export class EncryptedSendError extends Error {
  readonly reason: EncryptedSendFailure;
  constructor(reason: EncryptedSendFailure, message: string) {
    super(message);
    this.name = "EncryptedSendError";
    this.reason = reason;
  }
}

export type OutgoingEncryption = {
  /** Resolves once our sender key has reached the group; rejects if distribution failed. */
  ensureSenderKey(): Promise<void>;
  groupEncrypt(plaintext: string): Promise<string | null>;
  pairwiseEncrypt(plaintext: string): Promise<string | null>;
};

/** Encrypt `plaintext` for a channel in encrypted mode, choosing the scheme by the
 *  channel's type. Throws EncryptedSendError when no ciphertext could be produced. */
export async function encryptOutgoing(
  channelType: ChannelType | undefined,
  plaintext: string,
  enc: OutgoingEncryption,
): Promise<string> {
  if (channelType === "group_dm") {
    await enc.ensureSenderKey();
    const wire = await enc.groupEncrypt(plaintext);
    if (!wire) throw new EncryptedSendError("no-group-sender-key", "group encryption isn't ready yet");
    return wire;
  }
  if (channelType === "dm") {
    const wire = await enc.pairwiseEncrypt(plaintext);
    if (!wire) throw new EncryptedSendError("no-signal-session", "no encrypted session with this person yet");
    return wire;
  }
  // A server channel, or a channel whose type we don't know yet: never guess a scheme.
  throw new EncryptedSendError("not-a-direct-chat", "this chat can't be encrypted");
}

export type DistributionTracker = {
  /** Run `run` unless this channel's distribution already succeeded; concurrent callers
   *  share the one in-flight run and see its result (a failure rejects them all and is
   *  not remembered, so the next call runs again). */
  ensure(channelId: string, run: () => Promise<void>): Promise<void>;
  /** Our sender key changed: the next ensure() distributes again, even if a run for the
   *  old key is still in flight. */
  forget(channelId: string): void;
};

export function createDistributionTracker(): DistributionTracker {
  const done = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  return {
    ensure(channelId, run) {
      if (done.has(channelId)) return Promise.resolve();
      const pending = inFlight.get(channelId);
      if (pending) return pending;
      const attempt: Promise<void> = run().then(
        () => {
          if (inFlight.get(channelId) !== attempt) return; // forgotten mid-run: stale key
          inFlight.delete(channelId);
          done.add(channelId);
        },
        (err: unknown) => {
          if (inFlight.get(channelId) === attempt) inFlight.delete(channelId);
          throw err;
        },
      );
      inFlight.set(channelId, attempt);
      return attempt;
    },
    forget(channelId) {
      done.delete(channelId);
      inFlight.delete(channelId);
    },
  };
}

/** Why a forward must not be sent (the toast to show), or null when it may go. A forward
 *  is re-sent as plaintext, so it must never cross an encryption boundary: not into a
 *  chat in encrypted mode, and not out of a message that was decrypted on this device. */
export function forwardBlockReason(message: { _encrypted?: boolean }, targetEncrypted: boolean): string | null {
  if (targetEncrypted) return "Can't forward into an encrypted chat yet.";
  if (message._encrypted) return "Encrypted messages can't be forwarded yet.";
  return null;
}
