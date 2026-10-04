/** The most attachments one message may carry; the server refuses more with a 400. */
export const MAX_ATTACHMENTS = 10;
export const TOO_MANY_ATTACHMENTS = `You can attach up to ${MAX_ATTACHMENTS} files to a message.`;

/** Which `incoming` files fit beside the ones already attached (pending or still
 *  uploading), and how many had to be left out. */
export function filesThatFit<F>(alreadyAttached: number, incoming: readonly F[]): { fit: F[]; leftOut: number } {
  const room = Math.max(0, MAX_ATTACHMENTS - alreadyAttached);
  return { fit: incoming.slice(0, room), leftOut: Math.max(0, incoming.length - room) };
}

/** Hold `n` attachment slots (files in flight) while `upload` runs, and give them back
 *  however it ends, so a failure can't shrink the allowance for good. */
export async function holdingSlots<T>(slots: { current: number }, n: number, upload: () => Promise<T>): Promise<T> {
  slots.current += n;
  try {
    return await upload();
  } finally {
    slots.current -= n;
  }
}
