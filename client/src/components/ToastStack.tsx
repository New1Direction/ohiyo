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
  error: "!",
  warn: "⚠",
};

type Props = { toasts: Toast[] };

export function ToastStack({ toasts }: Props) {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="false"
      className="ohiyo-toast-stack"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className="ohiyo-toast"
          style={{ ["--toast-color" as string]: COLORS[t.type] }}
        >
          <span className="ohiyo-toast-icon" aria-hidden="true">
            {ICONS[t.type]}
          </span>
          <span className="ohiyo-toast-text">{t.text}</span>
        </div>
      ))}
      <style>{`
        .ohiyo-toast-stack {
          position: fixed;
          bottom: 96px;
          right: 24px;
          z-index: 9999;
          display: flex;
          flex-direction: column;
          gap: 10px;
          pointer-events: none;
        }
        .ohiyo-toast {
          display: grid;
          grid-template-columns: auto 1fr;
          align-items: center;
          gap: 10px;
          width: min(360px, calc(100vw - 32px));
          padding: 12px 14px;
          border-radius: 18px;
          background: color-mix(in oklch, var(--bg-sidebar) 88%, black 12%);
          border: 1px solid color-mix(in oklch, var(--toast-color) 24%, var(--bg-hover));
          box-shadow: 0 22px 60px rgba(0,0,0,.36), 0 1px 0 rgba(255,255,255,.08) inset;
          color: var(--text-primary);
          font-size: 13px;
          line-height: 1.35;
          backdrop-filter: blur(18px);
          animation: toast-pop 180ms cubic-bezier(.16, 1, .3, 1);
        }
        .ohiyo-toast-icon {
          display: grid;
          place-items: center;
          width: 24px;
          height: 24px;
          border-radius: 999px;
          background: color-mix(in oklch, var(--toast-color) 16%, transparent);
          color: var(--toast-color);
          font-size: 13px;
          font-weight: 850;
        }
        .ohiyo-toast-text { min-width: 0; overflow-wrap: anywhere; }
        @keyframes toast-pop {
          from { opacity: 0; transform: translateY(8px) scale(.98); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @media (max-width: 640px) {
          .ohiyo-toast-stack { left: 16px; right: 16px; bottom: 84px; }
          .ohiyo-toast { width: 100%; }
        }
        @media (prefers-reduced-motion: reduce) {
          .ohiyo-toast { animation: none; }
        }
      `}</style>
    </div>
  );
}
