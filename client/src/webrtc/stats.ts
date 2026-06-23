// Parse RTCPeerConnection.getStats() into rate-based connection metrics.

export interface RawSample {
  t: number;
  rttMs: number | null;
  bytesSent: number;
  bytesReceived: number;
  packetsLost: number;
  packetsReceived: number;
  packetsSent: number;
  fractionLost: number | null;
  jitterMs: number | null;
}

export interface PeerMetrics {
  rttMs: number | null;
  jitterMs: number | null;
  lossRatio: number;
  fractionLost: number | null;
  inboundKbps: number;
  outboundKbps: number;
}

// RTCStats fields beyond the lib.dom base type — read defensively.
type AnyStat = RTCStats & Record<string, unknown>;
const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

export function extractSample(report: RTCStatsReport): RawSample {
  let rttMs: number | null = null;
  let bytesSent = 0;
  let bytesReceived = 0;
  let packetsLost = 0;
  let packetsReceived = 0;
  let packetsSent = 0;
  let fractionLost: number | null = null;
  let jitterSecMax: number | null = null;

  let selectedPairId: string | undefined;
  report.forEach((r0) => {
    const r = r0 as AnyStat;
    if (r.type === "transport" && typeof r.selectedCandidatePairId === "string") {
      selectedPairId = r.selectedCandidatePairId;
    }
  });

  report.forEach((r0) => {
    const r = r0 as AnyStat;
    switch (r.type) {
      case "candidate-pair": {
        const active = selectedPairId
          ? r.id === selectedPairId
          : (r.nominated === true && r.state === "succeeded") || r.selected === true;
        const rtt = num(r.currentRoundTripTime);
        if (active && rtt !== undefined) rttMs = rtt * 1000;
        break;
      }
      case "outbound-rtp":
        if (!r.isRemote) {
          bytesSent += num(r.bytesSent) ?? 0;
          packetsSent += num(r.packetsSent) ?? 0;
        }
        break;
      case "remote-inbound-rtp": {
        // The peer's RR about OUR uplink — authoritative send-side loss/jitter. This
        // send-side loss is surfaced via fractionLost; it must NOT be folded into
        // packetsLost (which pairs with the receive-side packetsReceived to derive the
        // inbound loss ratio — mixing the two inflates that ratio).
        const fl = num(r.fractionLost);
        if (fl !== undefined) fractionLost = fractionLost == null ? fl : Math.max(fractionLost, fl);
        const j = num(r.jitter);
        if (j !== undefined) jitterSecMax = jitterSecMax == null ? j : Math.max(jitterSecMax, j);
        const rtt = num(r.roundTripTime);
        if (rttMs == null && rtt !== undefined) rttMs = rtt * 1000;
        break;
      }
      case "inbound-rtp":
        if (!r.isRemote) {
          bytesReceived += num(r.bytesReceived) ?? 0;
          packetsReceived += num(r.packetsReceived) ?? 0;
          // Receive-side loss only — diffSamples pairs this with packetsReceived.
          const pl = num(r.packetsLost);
          if (pl !== undefined) packetsLost += Math.max(0, pl);
          const j = num(r.jitter);
          if (j !== undefined) jitterSecMax = jitterSecMax == null ? j : Math.max(jitterSecMax, j);
        }
        break;
    }
  });

  return {
    t: performance.now(),
    rttMs,
    bytesSent,
    bytesReceived,
    packetsLost,
    packetsReceived,
    packetsSent,
    fractionLost,
    jitterMs: jitterSecMax == null ? null : jitterSecMax * 1000,
  };
}

export function diffSamples(prev: RawSample | null, cur: RawSample): PeerMetrics {
  if (!prev) {
    return {
      rttMs: cur.rttMs,
      jitterMs: cur.jitterMs,
      lossRatio: cur.fractionLost ?? 0,
      fractionLost: cur.fractionLost,
      inboundKbps: 0,
      outboundKbps: 0,
    };
  }
  const dtSec = Math.max(0.001, (cur.t - prev.t) / 1000);
  const rxBytes = Math.max(0, cur.bytesReceived - prev.bytesReceived);
  const txBytes = Math.max(0, cur.bytesSent - prev.bytesSent);
  const dLost = Math.max(0, cur.packetsLost - prev.packetsLost);
  const dExpected = Math.max(0, cur.packetsReceived - prev.packetsReceived + dLost);
  const deltaLoss = dExpected > 0 ? dLost / dExpected : 0;
  const lossRatio = Math.min(1, Math.max(deltaLoss, cur.fractionLost ?? 0)); // take the worse
  return {
    rttMs: cur.rttMs,
    jitterMs: cur.jitterMs,
    lossRatio,
    fractionLost: cur.fractionLost,
    inboundKbps: (rxBytes * 8) / dtSec / 1000,
    outboundKbps: (txBytes * 8) / dtSec / 1000,
  };
}
