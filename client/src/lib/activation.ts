export type ActivationMilestone = "account" | "server" | "message" | "invite" | "call";

export type ActivationState = Record<ActivationMilestone, number | null>;

export const ACTIVATION_MILESTONES: ActivationMilestone[] = ["account", "server", "message", "invite", "call"];

const KEY = "ohiyo:activation:v1";
const DISMISSED_KEY = "ohiyo:activation:dismissed:v1";

function emptyState(): ActivationState {
  return { account: null, server: null, message: null, invite: null, call: null };
}

function readAll(): Record<string, ActivationState> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, Partial<ActivationState>>;
    const out: Record<string, ActivationState> = {};
    for (const [userId, state] of Object.entries(parsed)) {
      out[userId] = { ...emptyState(), ...state };
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, ActivationState>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Storage may be blocked/private; activation is nice-to-have only.
  }
}

export function loadActivation(userId: string | null | undefined): ActivationState {
  if (!userId) return emptyState();
  return readAll()[userId] ?? emptyState();
}

export function markActivation(userId: string | null | undefined, milestone: ActivationMilestone, at = Date.now()): ActivationState {
  if (!userId) return emptyState();
  const all = readAll();
  const current = all[userId] ?? emptyState();
  if (!current[milestone]) {
    all[userId] = { ...current, [milestone]: at };
    writeAll(all);
    try {
      window.dispatchEvent(new CustomEvent("ohiyo:activation", { detail: { userId, milestone } }));
    } catch {
      // ignore
    }
    return all[userId];
  }
  return current;
}

export function isActivationDismissed(userId: string | null | undefined): boolean {
  if (!userId) return false;
  try {
    const parsed = JSON.parse(localStorage.getItem(DISMISSED_KEY) || "{}") as Record<string, boolean>;
    return Boolean(parsed[userId]);
  } catch {
    return false;
  }
}

export function setActivationDismissed(userId: string | null | undefined, dismissed: boolean) {
  if (!userId) return;
  try {
    const parsed = JSON.parse(localStorage.getItem(DISMISSED_KEY) || "{}") as Record<string, boolean>;
    if (dismissed) parsed[userId] = true;
    else delete parsed[userId];
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(parsed));
    window.dispatchEvent(new CustomEvent("ohiyo:activation-dismissed", { detail: { userId, dismissed } }));
  } catch {
    // ignore
  }
}

export function activationCompletedCount(state: ActivationState): number {
  return ACTIVATION_MILESTONES.filter((m) => Boolean(state[m])).length;
}
