// Settings → Help & feedback: the live status of this home, what's new, a prefilled bug report,
// questions and ideas, private security reports, the Terms and Privacy pages, and an honest note
// on getting back into an account.
import { useEffect, useState, type CSSProperties } from "react";
import {
  bugReportUrl,
  CHANGELOG_URL,
  describeClient,
  feedbackUrl,
  PRIVACY_URL,
  SECURITY_URL,
  STATUS_URL,
  SUPPORT_EMAIL,
  TERMS_URL,
} from "../../lib/helpLinks";

export type ServiceStatus = { ok: boolean; components?: { name: string; status: string }[] };

export type HelpTabProps = {
  version: string;
  desktop: boolean;
  home: string;
  userAgent: string;
  /** Reads this home's /reliability/status; keep its identity stable. */
  loadStatus: () => Promise<ServiceStatus>;
};

type StatusView = { kind: "loading" } | { kind: "ok" } | { kind: "problems"; names: string[] } | { kind: "error" };

function statusText(view: StatusView): string {
  switch (view.kind) {
    case "loading":
      return "Checking…";
    case "ok":
      return "All systems normal";
    case "problems":
      return view.names.length ? `Some parts aren't working: ${view.names.join(", ")}` : "Some parts aren't working right now";
    case "error":
      return "Couldn't check right now";
  }
}

const card: CSSProperties = { background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)" };

function HelpLink({ href, label, hint }: { href: string; label: string; hint: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="kc-help-link kc-interactive flex min-h-11 flex-col justify-center rounded-lg px-3 py-2"
      style={{ background: "var(--bg-input)", color: "var(--text-primary)", textDecoration: "none" }}
    >
      <span className="text-sm font-semibold">{label}</span>
      <span className="text-xs" style={{ color: "var(--text-muted)" }}>{hint}</span>
    </a>
  );
}

export function HelpTab({ version, desktop, home, userAgent, loadStatus }: HelpTabProps) {
  const info = describeClient(userAgent, desktop, version, home);
  const [status, setStatus] = useState<StatusView>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    loadStatus().then(
      (s) => {
        if (!alive) return;
        if (s.ok) setStatus({ kind: "ok" });
        else setStatus({ kind: "problems", names: (s.components ?? []).filter((c) => c.status !== "ok").map((c) => c.name) });
      },
      () => {
        if (alive) setStatus({ kind: "error" });
      },
    );
    return () => {
      alive = false;
    };
  }, [loadStatus]);

  const dot =
    status.kind === "ok" ? "var(--success, #3ba55c)" : status.kind === "loading" ? "var(--text-muted)" : "var(--warning, #f0b232)";

  return (
    <div>
      <h2 className="mb-1 text-xl font-bold">Help &amp; feedback</h2>
      <p className="mb-6 max-w-3xl text-sm leading-6" style={{ color: "var(--text-muted)" }}>
        Something not working, a question, or an idea? Here&apos;s where to go. Bug reports and questions are public on GitHub, so
        never paste passwords, recovery codes or private messages into them.
      </p>

      <div className="mb-6 rounded-lg p-4" style={card}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 999, background: dot, display: "inline-block" }} />
            <span data-help-status className="text-sm font-semibold" role="status" style={{ color: "var(--text-primary)" }}>
              {statusText(status)}
            </span>
          </div>
          <a
            href={STATUS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="kc-interactive rounded-full px-3 py-2 text-xs font-semibold"
            style={{ background: "var(--bg-input)", color: "var(--text-secondary)", textDecoration: "none" }}
          >
            Service status
          </a>
        </div>
      </div>

      <div className="mb-6 grid gap-2 md:grid-cols-2">
        <HelpLink href={bugReportUrl(info)} label="Report a bug" hint="Opens a public GitHub issue with your app version filled in" />
        <HelpLink href={feedbackUrl("question", info)} label="Ask a question" hint="Someone from the project will answer on GitHub" />
        <HelpLink href={feedbackUrl("idea", info)} label="Suggest an idea" hint="Tell us what would make Ohiyo better for you" />
        <HelpLink href={CHANGELOG_URL} label="What's new" hint="Everything that changed, release by release" />
        <HelpLink href={SECURITY_URL} label="Report a security issue privately" hint="Goes only to the maintainers, not the public" />
        {SUPPORT_EMAIL && <HelpLink href={`mailto:${SUPPORT_EMAIL}`} label="Email us" hint={SUPPORT_EMAIL} />}
      </div>

      <div className="mb-6 rounded-lg p-4" style={card}>
        <div className="mb-2 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Getting back into your account</div>
        <ul className="grid gap-2 text-xs leading-5" style={{ color: "var(--text-muted)" }}>
          <li>Ohiyo can&apos;t reset a password by email: it never asks for your email address.</li>
          <li>
            Signed in on another device? Choose <b>Link a device</b> on the sign-in screen here, and approve it from that device.
          </li>
          <li>
            Your encrypted chats come back with your recovery code, if you saved one (Settings → Privacy &amp; security).
          </li>
          <li>Signed out everywhere and the password forgotten? That account can&apos;t be recovered; you can make a new one.</li>
        </ul>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs" style={{ color: "var(--text-muted)" }}>
        <span>
          Ohiyo {info.version} · {info.platform === "desktop" ? "Desktop app" : "Web"} · {info.os}
        </span>
        <a href={TERMS_URL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-secondary)" }}>
          Terms
        </a>
        <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer" style={{ color: "var(--text-secondary)" }}>
          Privacy
        </a>
      </div>
    </div>
  );
}
