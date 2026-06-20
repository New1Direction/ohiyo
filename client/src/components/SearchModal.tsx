import { useEffect, useState } from "react";
import { api, type Message, type Channel } from "../api";
import { ModalShell } from "./ModalShell";

type Props = {
  token: string;
  serverId: string;
  channels: Channel[];
  onJump: (channelId: string) => void;
  onClose: () => void;
};

/** Search every channel in a server and jump to a result. */
export function SearchModal({ token, serverId, channels, onJump, onClose }: Props) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Message[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameOf = (cid: string) => channels.find((c) => c.id === cid)?.name ?? "channel";

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    const id = setTimeout(() => {
      api
        .searchMessages(token, serverId, term)
        .then((r) => alive && setResults(r))
        .catch(() => {
          if (!alive) return;
          setResults([]);
          setError("Search could not load. Check your connection and try again.");
        })
        .finally(() => alive && setLoading(false));
    }, 220);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [q, token, serverId]);

  const term = q.trim();

  return (
    <ModalShell onClose={onClose} labelledBy="kc-search-title" maxWidthClass="max-w-lg">
      <h2
        id="kc-search-title"
        style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-2xl)", color: "var(--text-primary)" }}
      >
        Search messages
      </h2>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search this server…"
        aria-label="Search messages"
        autoComplete="off"
        className="kc-field mt-4 w-full px-3.5 py-3 text-sm outline-none"
      />

      <div className="mt-3" style={{ minHeight: 140, maxHeight: 380, overflowY: "auto" }}>
        {loading ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => <div key={i} className="kc-skeleton" style={{ height: 52 }} />)}
          </div>
        ) : error ? (
          <Hint text={error} />
        ) : !term ? (
          <Hint text="Type to search across every channel." />
        ) : results.length === 0 ? (
          <Hint text={`No messages match "${term}".`} />
        ) : (
          <div className="flex flex-col gap-1">
            {results.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => { onJump(m.channel_id); onClose(); }}
                className="kc-pick-row kc-interactive flex flex-col px-3 py-2 text-left"
                style={{ borderRadius: "var(--radius-md)" }}
              >
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                  <span style={{ color: "var(--accent)", fontWeight: 600 }}>#{nameOf(m.channel_id)}</span>
                  {" · "}{m.author.display_name}{" · "}{fmt(m.created_at)}
                </div>
                <div className="truncate text-sm" style={{ color: "var(--text-secondary)" }}>
                  {m.content || "(attachment)"}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </ModalShell>
  );
}

function Hint({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center text-center text-sm" style={{ color: "var(--text-muted)", minHeight: 110 }}>
      {text}
    </div>
  );
}

function fmt(unix: number): string {
  const d = new Date(unix * 1000);
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
