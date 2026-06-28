import type { CoverageCheck } from "./recovery";

export type MissingSenderKey = {
  message_id: string;
  room_id: string;
  epoch: number | null;
  key_id: string;
  recorded_at: number;
};

const MISSING_KEY = "ohiyo:recovery-missing-sender-keys:v1";
const COVERAGE_KEY = "ohiyo:recovery-coverage:v1";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage disabled/full — recovery guidance degrades to generic copy */
  }
}

export function recordMissingSenderKey(candidate: Omit<MissingSenderKey, "recorded_at">): void {
  const existing = readJson<MissingSenderKey[]>(MISSING_KEY, []);
  const next = [
    ...existing.filter((item) => item.message_id !== candidate.message_id),
    { ...candidate, recorded_at: Date.now() },
  ].slice(-200);
  writeJson(MISSING_KEY, next);
}

export function missingSenderKeys(): MissingSenderKey[] {
  return readJson<MissingSenderKey[]>(MISSING_KEY, []);
}

export function saveCoverageResults(results: Record<string, CoverageCheck>): void {
  const existing = readJson<Record<string, CoverageCheck>>(COVERAGE_KEY, {});
  writeJson(COVERAGE_KEY, { ...existing, ...results });
}

export function coverageForMessage(messageId: string): CoverageCheck | null {
  return readJson<Record<string, CoverageCheck>>(COVERAGE_KEY, {})[messageId] ?? null;
}
