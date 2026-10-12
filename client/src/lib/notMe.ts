// "Not me" on the new-device alert. Kept apart from App so the order is testable.

export type NotMeSteps = {
  removeDevice(id: number): Promise<unknown>;
  endAllSessions(): Promise<unknown>;
  forget(ids: readonly number[]): void;
};

/** Take the devices off the account, then end every session (the one that added them
 *  included). They're forgotten only once both have worked: if either fails, the alert
 *  keeps them, so you can try again. */
export async function notMe(ids: readonly number[], steps: NotMeSteps): Promise<void> {
  for (const id of ids) await steps.removeDevice(id);
  await steps.endAllSessions();
  steps.forget(ids);
}
