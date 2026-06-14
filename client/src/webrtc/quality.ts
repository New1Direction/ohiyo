// Map connection metrics → a quality level, with hysteresis to stop badge flicker.

import type { PeerMetrics } from "./stats";

export type QualityLevel = "excellent" | "good" | "poor" | "critical" | "unknown";
export interface QualityThresholds { rttMs: number; lossRatio: number; jitterMs: number }

export const QUALITY_TABLE: ReadonlyArray<readonly [QualityLevel, QualityThresholds]> = [
  ["excellent", { rttMs: 150, lossRatio: 0.005, jitterMs: 15 }],
  ["good", { rttMs: 300, lossRatio: 0.02, jitterMs: 30 }],
  ["poor", { rttMs: 500, lossRatio: 0.05, jitterMs: 50 }],
] as const; // beyond "poor" → "critical"

export function scoreQuality(m: PeerMetrics): QualityLevel {
  if (m.rttMs == null && m.jitterMs == null && m.inboundKbps === 0 && m.outboundKbps === 0) {
    return "unknown";
  }
  const rtt = m.rttMs ?? 0;
  const jitter = m.jitterMs ?? 0;
  const loss = m.lossRatio;
  for (const [level, t] of QUALITY_TABLE) {
    if (rtt <= t.rttMs && loss <= t.lossRatio && jitter <= t.jitterMs) return level;
  }
  return "critical";
}

export function qualityToBars(l: QualityLevel): 0 | 1 | 2 | 3 | 4 {
  return ({ excellent: 4, good: 3, poor: 2, critical: 1, unknown: 0 } as const)[l];
}

const ORDER: QualityLevel[] = ["unknown", "critical", "poor", "good", "excellent"];

/** Require 2 consecutive readings to DROP a level → no badge flicker. */
export function smoothLevel(
  prev: QualityLevel,
  next: QualityLevel,
  pendingDrops: number,
): { level: QualityLevel; pendingDrops: number } {
  const dropping = ORDER.indexOf(next) < ORDER.indexOf(prev);
  if (dropping && pendingDrops < 1) return { level: prev, pendingDrops: pendingDrops + 1 };
  return { level: next, pendingDrops: 0 };
}
