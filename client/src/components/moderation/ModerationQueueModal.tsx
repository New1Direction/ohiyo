import { useCallback, useEffect, useState } from "react";
import { ModalShell } from "../ModalShell";
import { api, type AbuseReport } from "../../api";
import { ModerationLog } from "./ModerationLog";
import "./moderation.css";

/** Open reports to resolve or dismiss, and the space's moderation log. */
export function ModerationQueueModal({
  token,
  serverId,
  channelName,
  onToast,
  onClose,
}: {
  token: string;
  serverId: string;
  /** A channel's name by id, for log entries about a channel (slowmode). */
  channelName?: (id: string) => string | undefined;
  onToast: (message: string, type?: "success" | "error" | "info") => void;
  onClose: () => void;
}) {
  const [reports, setReports] = useState<AbuseReport[]>([]);
  const [loading, setLoading] = useState(true);
  // Bumped after resolving a report, so the log shows it.
  const [logVersion, setLogVersion] = useState(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setReports(await api.listModQueue(token, serverId));
    } catch (err) {
      onToast(`Couldn't load moderation queue: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setLoading(false);
    }
  }, [token, serverId, onToast]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function resolve(report: AbuseReport, status: "resolved" | "dismissed") {
    const note = window.prompt(status === "resolved" ? "Resolution note" : "Why dismiss this report?", "") ?? "";
    try {
      await api.resolveReport(token, serverId, report.id, status, note);
      onToast(status === "resolved" ? "Report resolved" : "Report dismissed", "success");
      void refresh();
      setLogVersion((v) => v + 1);
    } catch (err) {
      onToast(`Couldn't update report: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  return (
    <ModalShell onClose={onClose} labelledBy="moderation-queue-title" maxWidthClass="max-w-2xl">
      <div className="space-y-4 text-sm" style={{ color: "var(--text-secondary)" }}>
        <div className="flex items-center justify-between gap-3">
          <h2 id="moderation-queue-title" className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>Moderation queue</h2>
          <button type="button" className="kc-icon-btn" onClick={onClose} aria-label="Close moderation queue">×</button>
        </div>
        <p>
          Reports keep message text out of moderator metadata by default. Resolve what you reviewed, dismiss false alarms,
          and use the moderation log to see who did what, and why.
        </p>
        {loading ? (
          <div className="rounded-xl border p-4" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-input)" }}>Loading…</div>
        ) : reports.length === 0 ? (
          <div className="rounded-xl border p-4" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-input)" }}>No open reports.</div>
        ) : (
          <div className="space-y-3">
            {reports.map((report) => (
              <div key={report.id} className="rounded-xl border p-4" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-input)" }}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <strong style={{ color: "var(--text-primary)" }}>{report.target_type} report</strong>
                  <span className="text-xs uppercase tracking-wide" style={{ color: "var(--danger)" }}>{report.reason}</span>
                </div>
                <div className="mt-2 grid gap-1 text-xs">
                  <span>Target: <code>{report.target_id}</code></span>
                  {report.accused_user_id && <span>Accused user: <code>{report.accused_user_id}</code></span>}
                  {report.channel_id && <span>Channel: <code>{report.channel_id}</code></span>}
                  {report.details && <span>Details: {report.details}</span>}
                </div>
                <div className="mt-3 flex gap-2">
                  <button type="button" className="kc-button-primary" onClick={() => void resolve(report, "resolved")}>Resolve</button>
                  <button type="button" className="kc-button-secondary" onClick={() => void resolve(report, "dismissed")}>Dismiss</button>
                </div>
              </div>
            ))}
          </div>
        )}
        <ModerationLog
          key={logVersion}
          channelName={channelName}
          api={{ list: (opts) => api.listModerationActions(token, serverId, opts) }}
        />
      </div>
    </ModalShell>
  );
}
