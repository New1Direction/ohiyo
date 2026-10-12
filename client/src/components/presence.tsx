// Presence pieces shared by the channel sidebar and the user panel.
import type { ConnectionStatus } from "../gateway";

export const STATUS_META: Record<ConnectionStatus, { label: string; color: string }> = {
  connected: { label: "Connected", color: "var(--green)" },
  connecting: { label: "Connecting…", color: "#E8A23D" },
  disconnected: { label: "Reconnecting you now…", color: "var(--danger)" },
  signed_out: { label: "Signed out", color: "var(--danger)" },
};

export function OnlineDot({ color = "var(--green)" }: { color?: string }) {
  return (
    <span
      style={{
        position: "absolute", right: -1, bottom: -1, width: 11, height: 11,
        borderRadius: "var(--radius-full)", background: color,
        border: "2.5px solid var(--bg-sidebar)",
      }}
    />
  );
}
