import { memo } from "react";
import { qualityToBars, type QualityLevel } from "../webrtc/quality";
import "./connection-badge.css";

const LABELS: Record<QualityLevel, string> = {
  excellent: "Excellent connection",
  good: "Good connection",
  poor: "Poor connection",
  critical: "Critical connection",
  unknown: "Measuring connection",
};

export const ConnectionBadge = memo(function ConnectionBadge({
  level,
  size = 14,
}: {
  level: QualityLevel;
  size?: number;
}) {
  const bars = qualityToBars(level);
  const styleVar = { ["--badge-size" as string]: `${size}px` } as React.CSSProperties;

  if (level === "unknown") {
    return (
      <span className="conn-badge conn-badge--unknown" role="img" aria-label={LABELS.unknown} style={styleVar}>
        <span className="conn-dot" />
      </span>
    );
  }
  return (
    <span
      className={`conn-badge conn-badge--${level}`}
      role="img"
      aria-label={LABELS[level]}
      title={LABELS[level]}
      style={styleVar}
    >
      {[1, 2, 3, 4].map((i) => (
        <span key={i} className={`conn-bar ${i <= bars ? "is-on" : "is-off"}`} data-bar={i} />
      ))}
    </span>
  );
});
