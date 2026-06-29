import type { CoverageCheck } from "./recovery";

export type MissingSenderKey = {
  message_id: string;
  room_id: string;
  epoch: number | null;
  key_id: string;
  recorded_at: number;
};

export type SignalRecoveryRecord = {
  message_id: string;
  channel_id: string;
  author_id: string;
  sender_device_id: number | null;
  recipient_count: number | null;
  recorded_at: number;
};

const MISSING_KEY = "ohiyo:recovery-missing-sender-keys:v2";
const SIGNAL_KEY = "ohiyo:recovery-signal-messages:v1";
const COVERAGE_KEY = "ohiyo:recovery-coverage:v2";
const LEGACY_MISSING_KEY = "ohiyo:recovery-missing-sender-keys:v1";
const LEGACY_COVERAGE_KEY = "ohiyo:recovery-coverage:v1";
const MAX_RECORDS = 2000;

let scope = "global";

function safePart(value: string | null | undefined): string {
  return (value ?? "unknown").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 96);
}

/** Scope the durable ledger to one account on one Ohiyo home. */
export function configureRecoveryCoverageScope(homeId: string | null | undefined, userId: string | null | undefined): void {
  scope = `${safePart(homeId)}:${safePart(userId)}`;
}

function scoped(key: string): string {
  return `${key}:${scope}`;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function session(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readJson<T>(key: string, fallback: T, legacyKey?: string): T {
  const keys = [scoped(key), key, legacyKey].filter((v): v is string => Boolean(v));
  for (const store of [storage(), session()]) {
    if (!store) continue;
    for (const candidate of keys) {
      try {
        const raw = store.getItem(candidate);
        if (raw) return JSON.parse(raw) as T;
      } catch {
        /* try next source */
      }
    }
  }
  return fallback;
}

function writeJson(key: string, value: unknown): void {
  try {
    storage()?.setItem(scoped(key), JSON.stringify(value));
  } catch {
    try {
      session()?.setItem(scoped(key), JSON.stringify(value));
    } catch {
      /* storage disabled/full — recovery guidance degrades to generic copy */
    }
  }
}

function upsertBounded<T extends { message_id: string; recorded_at: number }>(items: T[], item: T): T[] {
  return [...items.filter((existing) => existing.message_id !== item.message_id), item]
    .sort((a, b) => a.recorded_at - b.recorded_at)
    .slice(-MAX_RECORDS);
}

/** Record a group sender-key ciphertext header, even if this device can decrypt it now.
 * The restore preview can later check this key id against the recovery-code-blinded
 * manifest, including after a reload or after scanning history that was not open. */
export function recordGroupSenderKeyMessage(candidate: Omit<MissingSenderKey, "recorded_at">): void {
  const existing = readJson<MissingSenderKey[]>(MISSING_KEY, [], LEGACY_MISSING_KEY);
  writeJson(MISSING_KEY, upsertBounded(existing, { ...candidate, recorded_at: Date.now() }));
}

/** Backward-compatible name: older callers recorded only decrypt failures. */
export const recordMissingSenderKey = recordGroupSenderKeyMessage;

export function missingSenderKeys(): MissingSenderKey[] {
  return readJson<MissingSenderKey[]>(MISSING_KEY, [], LEGACY_MISSING_KEY);
}

/** Record a Signal 1:1 ciphertext so restore preview can be honest about current
 * limitations. Signal Double Ratchet messages do not have a stable public manifest
 * membership test like group sender keys, so these classify as unavailable until a
 * restore attempt can actually try the restored ratchet state. */
export function recordSignalMessage(candidate: Omit<SignalRecoveryRecord, "recorded_at">): void {
  const existing = readJson<SignalRecoveryRecord[]>(SIGNAL_KEY, []);
  writeJson(SIGNAL_KEY, upsertBounded(existing, { ...candidate, recorded_at: Date.now() }));
}

export function signalMessagesForRecovery(): SignalRecoveryRecord[] {
  return readJson<SignalRecoveryRecord[]>(SIGNAL_KEY, []);
}

export function saveCoverageResults(results: Record<string, CoverageCheck>): void {
  const existing = readJson<Record<string, CoverageCheck>>(COVERAGE_KEY, {}, LEGACY_COVERAGE_KEY);
  writeJson(COVERAGE_KEY, { ...existing, ...results });
}

export function coverageForMessage(messageId: string): CoverageCheck | null {
  return readJson<Record<string, CoverageCheck>>(COVERAGE_KEY, {}, LEGACY_COVERAGE_KEY)[messageId] ?? null;
}
