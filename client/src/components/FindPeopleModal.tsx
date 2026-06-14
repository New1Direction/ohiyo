import { useEffect, useState } from "react";
import { api, type PublicUser } from "../api";
import { ModalShell } from "./ModalShell";

type Props = {
  token: string;
  onOpenDm: (user: PublicUser) => void;
  onClose: () => void;
};

/** Search people by name and start a DM in one tap. */
export function FindPeopleModal({ token, onOpenDm, onClose }: Props) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Debounced search.
  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResults([]);
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    const id = setTimeout(() => {
      api
        .searchUsers(token, term)
        .then((r) => alive && setResults(r))
        .catch(() => alive && setResults([]))
        .finally(() => alive && setLoading(false));
    }, 220);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [q, token]);

  async function start(user: PublicUser) {
    setBusyId(user.id);
    onOpenDm(user);
  }

  const term = q.trim();

  return (
    <ModalShell onClose={onClose} labelledBy="kc-find-title" maxWidthClass="max-w-md">
      <h2
        id="kc-find-title"
        style={{
          fontFamily: "var(--font-display)", fontWeight: 700,
          fontSize: "var(--text-2xl)", color: "var(--text-primary)",
        }}
      >
        Find people
      </h2>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        Search by name and start a conversation.
      </p>

      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search by username or name…"
        aria-label="Search people"
        autoComplete="off"
        className="kc-field mt-4 w-full px-3.5 py-3 text-sm outline-none"
      />

      <div className="mt-3" style={{ minHeight: 120, maxHeight: 320, overflowY: "auto" }}>
        {loading ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="kc-skeleton" style={{ height: 52 }} />
            ))}
          </div>
        ) : !term ? (
          <EmptyHint text="Type a name to get started." />
        ) : results.length === 0 ? (
          <EmptyHint text={`No one matches "${term}" yet.`} />
        ) : (
          <div className="flex flex-col gap-1">
            {results.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => start(u)}
                disabled={busyId === u.id}
                className="kc-interactive flex items-center gap-3 px-2.5 py-2 text-left"
                style={{ borderRadius: "var(--radius-md)", background: "transparent" }}
              >
                <div
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold"
                  style={{
                    background: "var(--accent)", color: "#fff",
                    backgroundImage: u.avatar_url ? `url(${u.avatar_url})` : undefined,
                    backgroundSize: "cover", backgroundPosition: "center",
                  }}
                >
                  {!u.avatar_url && (u.display_name[0] ?? u.username[0] ?? "?").toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                    {u.display_name}
                  </div>
                  <div className="truncate text-xs" style={{ color: "var(--text-muted)" }}>
                    @{u.username}
                  </div>
                </div>
                <span className="flex-shrink-0 text-xs font-semibold" style={{ color: "var(--accent)" }}>
                  {busyId === u.id ? "Opening…" : "Message"}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </ModalShell>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div
      className="flex h-full items-center justify-center text-center text-sm"
      style={{ color: "var(--text-muted)", minHeight: 100 }}
    >
      {text}
    </div>
  );
}
