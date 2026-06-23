import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  /** Custom fallback. If a function, it receives the error and a reset callback. */
  fallback?: ReactNode | ((error: Error, reset: () => void) => ReactNode);
  /** Called after the boundary resets (e.g. to re-fetch or remount the subtree). */
  onReset?: () => void;
  /** Short label for the default fallback ("Voice call", "Watch party", …). */
  label?: string;
};

type State = { error: Error | null };

/**
 * Catches render/lifecycle throws in a subtree so a single feature failing
 * (a plugin transform, a WebRTC hiccup, a YouTube iframe) degrades to a small
 * themed message instead of white-screening the whole app. React error
 * boundaries must be class components — there is no hook equivalent yet.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[error-boundary]${this.props.label ? ` ${this.props.label}:` : ""}`, error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const { fallback, label } = this.props;
    if (typeof fallback === "function") return fallback(error, this.reset);
    if (fallback !== undefined) return fallback;

    return (
      <div
        role="alert"
        style={{
          padding: "var(--space-4, 16px)",
          margin: "var(--space-2, 8px)",
          borderRadius: "var(--radius-lg, 12px)",
          background: "color-mix(in oklch, var(--danger, #c0392b) 10%, var(--bg-input, #1e1e22))",
          border: "1px solid color-mix(in oklch, var(--danger, #c0392b) 30%, transparent)",
          color: "var(--text-primary, #eaeaea)",
          fontSize: "var(--text-sm, 0.875rem)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--space-2, 8px)",
          alignItems: "flex-start",
        }}
      >
        <div style={{ fontWeight: 700 }}>
          {label ? `${label} hit a snag` : "Something went wrong"}
        </div>
        <div style={{ color: "var(--text-secondary, #b5b5b5)" }}>
          This part stopped, but the rest of Ohiyo keeps working. You can try again.
        </div>
        <button
          type="button"
          onClick={this.reset}
          className="kc-interactive"
          style={{
            border: "none",
            cursor: "pointer",
            borderRadius: "var(--radius-md, 8px)",
            padding: "6px 14px",
            fontWeight: 600,
            background: "var(--accent, #5865f2)",
            color: "#fff",
          }}
        >
          Try again
        </button>
      </div>
    );
  }
}
