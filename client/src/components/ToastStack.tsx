import type { Toast } from "../hooks/useToast";

const COLORS: Record<Toast["type"], string> = {
  info: "var(--accent)",
  success: "var(--green)",
  error: "var(--danger)",
  warn: "#f0a500",
};

const ICONS: Record<Toast["type"], string> = {
  info: "ℹ",
  success: "✓",
  error: "✕",
  warn: "⚠",
};

type Props = { toasts: Toast[] };

export function ToastStack({ toasts }: Props) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      style={{
        position: "fixed",
        bottom: 24,
        right: 24,
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 16px",
            borderRadius: "var(--radius-md)",
            background: "var(--bg-sidebar)",
            boxShadow: "var(--shadow-lg)",
            borderLeft: `4px solid ${COLORS[t.type]}`,
            color: "var(--text-primary)",
            fontSize: 13,
            minWidth: 240,
            animation: "slideIn 0.15s ease-out",
          }}
        >
          <span style={{ color: COLORS[t.type], fontSize: 14, fontWeight: 700 }}>
            {ICONS[t.type]}
          </span>
          {t.text}
        </div>
      ))}
      <style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(20px); }
          to   { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}
