// Keeping your own encrypted message readable while it is being sent.
//
// When you send an encrypted message, two things answer it: the server's reply to the send,
// and the same message echoed back over the live connection. Nobody can decrypt their own
// outgoing ciphertext (the ratchet, or the group sender key, has already moved on), so only
// the send knows the text. The two arrive in either order, and the echo's decrypt attempt
// takes a while. Whichever lands second must not undo the first. Pure, for unit tests.

/** The parts of a shown message these rules read. */
interface Shown {
  content: string;
  attachments?: unknown;
  _encrypted?: boolean;
  _decryptState?: unknown;
}

/** The message as its sender sees it once the server has accepted the send (or the edit):
 *  the text they wrote, and no "can't decrypt" notice left over from the echo. */
export function withOwnPlaintext<M extends Shown>(shown: M, content: string, attachments?: M["attachments"]): M {
  const { _decryptState: _notice, ...rest } = shown;
  return { ...rest, content, attachments: attachments ?? shown.attachments, _encrypted: true } as M;
}

/** What the list should hold after a decrypt attempt on a message it already shows. An
 *  attempt that worked always wins. One that failed replaces a message nobody could read
 *  yet, but never one that is already readable: that is the sender's own text, put there by
 *  the send while this attempt was still running. */
export function afterDecryptAttempt<M extends Shown>(shown: M, attempt: M): M {
  const attemptFailed = attempt._decryptState !== undefined;
  const alreadyReadable = shown._encrypted === true && shown._decryptState === undefined;
  return attemptFailed && alreadyReadable ? shown : attempt;
}
