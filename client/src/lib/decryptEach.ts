/** Decrypt `messages` one after another, in order (the Double Ratchet needs in-order
 *  processing). A message whose decrypt throws, for any reason (a malformed stored sender
 *  key, a corrupt cache entry), becomes `undecryptable(m)` and the rest still load. */
export async function decryptEach<M>(
  messages: readonly M[],
  decryptOne: (m: M) => Promise<M>,
  undecryptable: (m: M) => M,
): Promise<M[]> {
  const out: M[] = [];
  for (const m of messages) {
    try {
      out.push(await decryptOne(m));
    } catch {
      out.push(undecryptable(m));
    }
  }
  return out;
}
