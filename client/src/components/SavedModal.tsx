import { useEffect, useState } from "react";
import { api, type Message } from "../api";
import { ModalShell } from "./ModalShell";

type Props = {
  token: string;
  onJump: (channelId: string) => void;
  onClose: () => void;
};

/** Your bookmarked messages — jump back to any, or remove it. */
export function SavedModal({ token, onJump, onClose }: Props) {
  const [saved, setSaved] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      setError(null);
      setSaved(await api.listSaved(token));
    } catch {
      setSaved([]);
      setError("Saved messages could not load. Check your connection and try again.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function remove(m: Message) {
    try {
      await api.unsaveMessage(token, m.channel_id, m.id);
      await refresh();
    } catch {
      setError("Could not remove that saved message. Try again.");
    }
  }

  return (
    <ModalShell onClose={onClose} labelledBy="kc-saved-title" maxWidthClass="max-w-lg">
      <h2
        id="kc-saved-title"
        style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-2xl)", color: "var(--text-primary)" }}
      >
        🔖 Saved messages
      </h2>

      <div className="mt-4 flex flex-col gap-1.5" style={{ maxHeight: 400, overflowY: "auto" }}>
        {loading ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => <div key={i} className="kc-skeleton" style={{ height: 52 }} />)}
          </div>
        ) : error ? (
          <p role="alert" className="text-center text-sm" style={{ color: "var(--danger)", padding: "var(--space-5)" }}>
            {error}
          </p>
        ) : saved.length === 0 ? (
          <p className="text-center text-sm" style={{ color: "var(--text-muted)", padding: "var(--space-5)" }}>
            Nothing saved yet. Hit the 🔖 on any message to keep it here.
          </p>
        ) : (
          saved.map((m) => (
            <div
              key={m.id}
              className="flex items-center gap-3 px-3 py-2"
              style={{ borderRadius: "var(--radius-md)", background: "var(--bg-input)" }}
            >
              <div
                className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold"
                style={{ background: "var(--accent)", color: "#fff" }}
              >
                {(m.author.display_name[0] ?? "?").toUpperCase()}
              </div>
              <button
                type="button"
                onClick={() => { onJump(m.channel_id); onClose(); }}
                className="kc-interactive min-w-0 flex-1 text-left"
                style={{ background: "none", border: "none", cursor: "pointer" }}
              >
                <div className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>{m.author.display_name}</div>
                <div className="truncate text-sm" style={{ color: "var(--text-secondary)" }}>{m.content || "(attachment)"}</div>
              </button>
              <button
                type="button"
                onClick={() => remove(m)}
                aria-label="Remove from saved"
                className="kc-interactive flex-shrink-0"
                style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
              >
                ✕
              </button>
            </div>
          ))
        )}
      </div>
    </ModalShell>
  );
}
