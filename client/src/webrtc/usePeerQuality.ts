import { useEffect, useRef, useState } from "react";
import { extractSample, diffSamples, type RawSample, type PeerMetrics } from "./stats";
import { scoreQuality, smoothLevel, type QualityLevel } from "./quality";

const POLL_MS = 2000;

export interface PeerQuality {
  level: QualityLevel;
  metrics: PeerMetrics;
  updatedAt: number;
}

interface PeerState {
  prevSample: RawSample | null;
  level: QualityLevel;
  pendingDrops: number;
}

/**
 * Poll getStats() for every peer once per interval and expose a quality level.
 * `getPeers` returns the live peer-connection map; `peerIds` re-arms the timer
 * only when the SET of peers changes.
 */
export function usePeerQuality(
  getPeers: () => Map<string, RTCPeerConnection>,
  peerIds: string[],
): Record<string, PeerQuality> {
  const [quality, setQuality] = useState<Record<string, PeerQuality>>({});
  const stateRef = useRef<Map<string, PeerState>>(new Map());
  const getPeersRef = useRef(getPeers);
  getPeersRef.current = getPeers;

  const idsKey = [...peerIds].sort().join(",");

  useEffect(() => {
    let alive = true;
    let inFlight = false;

    const tick = async () => {
      const current = getPeersRef.current();
      const results = await Promise.allSettled(
        [...current.entries()].map(async ([id, pc]) => ({ id, sample: extractSample(await pc.getStats()) })),
      );
      if (!alive) return;
      setQuality((prev) => {
        const st = stateRef.current;
        const out: Record<string, PeerQuality> = { ...prev };
        for (const r of results) {
          if (r.status !== "fulfilled") continue;
          const { id, sample } = r.value;
          const ps = st.get(id) ?? { prevSample: null, level: "unknown" as QualityLevel, pendingDrops: 0 };
          const metrics = diffSamples(ps.prevSample, sample);
          const scored = scoreQuality(metrics);
          const { level, pendingDrops } = smoothLevel(ps.level, scored, ps.pendingDrops);
          st.set(id, { prevSample: sample, level, pendingDrops });
          out[id] = { level, metrics, updatedAt: sample.t };
        }
        for (const id of Object.keys(out)) {
          if (!current.has(id)) {
            delete out[id];
            st.delete(id);
          }
        }
        return out;
      });
    };

    const run = async () => {
      if (!alive || inFlight) return;
      inFlight = true;
      try {
        await tick();
      } finally {
        inFlight = false;
      }
    };

    run();
    const h = window.setInterval(run, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(h);
    };
  }, [idsKey]);

  return quality;
}
