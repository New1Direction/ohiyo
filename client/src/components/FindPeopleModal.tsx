import { useEffect, useState } from "react";
import { api, type FriendItem, type FriendshipStatus, type PublicUser } from "../api";
import { ModalShell } from "./ModalShell";

type Props = {
  token: string;
  onOpenDm: (user: PublicUser) => void | Promise<void>;
  onClose: () => void;
};

/** Search people by name and start a DM in one tap. */
export function FindPeopleModal({ token, onOpenDm, onClose }: Props) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<PublicUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [friends, setFriends] = useState<FriendItem[]>([]);
  const [friendsLoading, setFriendsLoading] = useState(true);
  const [relations, setRelations] = useState<Record<string, FriendshipStatus>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setFriendsLoading(true);
    setError(null);
    api
      .listFriends(token)
      .then((items) => {
        if (!alive) return;
        setFriends(items);
        setRelations(Object.fromEntries(items.map((it) => [it.user.id, it.status === "accepted" ? "friends" : it.direction === "incoming" ? "pending_incoming" : "pending_outgoing"])));
      })
      .catch(() => {
        if (!alive) return;
        setFriends([]);
        setError("Friends could not load. Check your connection and try again.");
      })
      .finally(() => alive && setFriendsLoading(false));
    return () => {
      alive = false;
    };
  }, [token]);

  // Debounced search.
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
        .searchUsers(token, term)
        .then((r) => alive && setResults(r))
        .catch(() => {
          if (!alive) return;
          setResults([]);
          setError("People search could not load. Check your connection and try again.");
        })
        .finally(() => alive && setLoading(false));
    }, 220);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [q, token]);

  async function start(user: PublicUser) {
    setBusyId(user.id);
    try {
      await onOpenDm(user);
    } catch {
      setError("Could not open that chat. Try again.");
      setBusyId(null);
    }
  }

  async function friendAction(user: PublicUser, action: "add" | "accept" | "remove") {
    setBusyId(user.id);
    try {
      if (action === "add") {
        const rel = await api.sendFriendRequest(token, user.id);
        setRelations((prev) => ({ ...prev, [user.id]: rel.status }));
      } else if (action === "accept") {
        const rel = await api.acceptFriendRequest(token, user.id);
        setRelations((prev) => ({ ...prev, [user.id]: rel.status }));
      } else {
        await api.deleteFriendship(token, user.id);
        setRelations((prev) => ({ ...prev, [user.id]: "none" }));
      }
      setFriends(await api.listFriends(token));
    } catch {
      setError("Could not update that friend request. Try again.");
    } finally {
      setBusyId(null);
    }
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
        ) : error ? (
          <EmptyHint text={error} danger />
        ) : !term ? (
          <FriendsHome
            items={friends}
            loading={friendsLoading}
            busyId={busyId}
            onMessage={start}
            onFriendAction={friendAction}
          />
        ) : results.length === 0 ? (
          <EmptyHint text={`No one matches "${term}" yet.`} />
        ) : (
          <div className="flex flex-col gap-1">
            {results.map((u) => (
              <PersonRow
                key={u.id}
                user={u}
                busy={busyId === u.id}
                relation={relations[u.id] ?? "none"}
                onMessage={() => start(u)}
                onFriendAction={(action) => friendAction(u, action)}
              />
            ))}
          </div>
        )}
      </div>
    </ModalShell>
  );
}

function FriendsHome({
  items,
  loading,
  busyId,
  onMessage,
  onFriendAction,
}: {
  items: FriendItem[];
  loading: boolean;
  busyId: string | null;
  onMessage: (user: PublicUser) => void;
  onFriendAction: (user: PublicUser, action: "add" | "accept" | "remove") => void;
}) {
  if (loading) return <EmptyHint text="Loading friends…" />;
  if (items.length === 0) return <EmptyHint text="Type a name to add your first friend." />;
  const incoming = items.filter((it) => it.status === "pending" && it.direction === "incoming");
  const outgoing = items.filter((it) => it.status === "pending" && it.direction === "outgoing");
  const accepted = items.filter((it) => it.status === "accepted");
  return (
    <div className="flex flex-col gap-3">
      {incoming.length > 0 && <Section title="Friend requests" items={incoming} busyId={busyId} onMessage={onMessage} onFriendAction={onFriendAction} />}
      {accepted.length > 0 && <Section title="Friends" items={accepted} busyId={busyId} onMessage={onMessage} onFriendAction={onFriendAction} />}
      {outgoing.length > 0 && <Section title="Sent" items={outgoing} busyId={busyId} onMessage={onMessage} onFriendAction={onFriendAction} />}
    </div>
  );
}

function Section({
  title,
  items,
  busyId,
  onMessage,
  onFriendAction,
}: {
  title: string;
  items: FriendItem[];
  busyId: string | null;
  onMessage: (user: PublicUser) => void;
  onFriendAction: (user: PublicUser, action: "add" | "accept" | "remove") => void;
}) {
  return (
    <div>
      <div className="mb-1 px-1 text-[10px] font-bold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{title}</div>
      <div className="flex flex-col gap-1">
        {items.map((it) => (
          <PersonRow
            key={it.user.id}
            user={it.user}
            busy={busyId === it.user.id}
            relation={it.status === "accepted" ? "friends" : it.direction === "incoming" ? "pending_incoming" : "pending_outgoing"}
            onMessage={() => onMessage(it.user)}
            onFriendAction={(action) => onFriendAction(it.user, action)}
          />
        ))}
      </div>
    </div>
  );
}

function PersonRow({
  user,
  busy,
  relation,
  onMessage,
  onFriendAction,
}: {
  user: PublicUser;
  busy: boolean;
  relation: FriendshipStatus;
  onMessage: () => void;
  onFriendAction: (action: "add" | "accept" | "remove") => void;
}) {
  return (
    <div className="flex items-center gap-3 px-2.5 py-2" style={{ borderRadius: "var(--radius-md)", background: "transparent" }}>
      <div
        className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold"
        style={{
          background: "var(--accent)", color: "#fff",
          backgroundImage: user.avatar_url ? `url(${user.avatar_url})` : undefined,
          backgroundSize: "cover", backgroundPosition: "center",
        }}
      >
        {!user.avatar_url && (user.display_name[0] ?? user.username[0] ?? "?").toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{user.display_name}</div>
        <div className="truncate text-xs" style={{ color: "var(--text-muted)" }}>@{user.username}</div>
      </div>
      <div className="flex flex-shrink-0 items-center gap-1">
        {relation === "pending_incoming" ? (
          <>
            <MiniButton busy={busy} label="Accept" ariaLabel={`Accept friend request from @${user.username}`} onClick={() => onFriendAction("accept")} primary />
            <MiniButton busy={busy} label="Decline" ariaLabel={`Decline friend request from @${user.username}`} onClick={() => onFriendAction("remove")} />
          </>
        ) : relation === "pending_outgoing" ? (
          <MiniButton busy={busy} label="Sent" ariaLabel={`Cancel friend request to @${user.username}`} onClick={() => onFriendAction("remove")} />
        ) : relation === "friends" ? (
          <MiniButton busy={busy} label="Message" ariaLabel={`Message @${user.username}`} onClick={onMessage} primary />
        ) : (
          <MiniButton busy={busy} label="Add" ariaLabel={`Add @${user.username} as friend`} onClick={() => onFriendAction("add")} primary />
        )}
        {relation !== "friends" && <MiniButton busy={busy} label="Message" ariaLabel={`Message @${user.username}`} onClick={onMessage} />}
      </div>
    </div>
  );
}

function MiniButton({ label, ariaLabel, busy, primary = false, onClick }: { label: string; ariaLabel?: string; busy: boolean; primary?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={busy}
      aria-label={ariaLabel ?? label}
      onClick={onClick}
      className="kc-interactive rounded-full px-2.5 py-1 text-xs font-semibold"
      style={{ border: "none", cursor: busy ? "default" : "pointer", background: primary ? "var(--accent)" : "var(--bg-input)", color: primary ? "#fff" : "var(--text-secondary)" }}
    >
      {busy ? "…" : label}
    </button>
  );
}

function EmptyHint({ text, danger = false }: { text: string; danger?: boolean }) {
  return (
    <div
      className="flex h-full items-center justify-center text-center text-sm"
      role={danger ? "alert" : undefined}
      style={{ color: danger ? "var(--danger)" : "var(--text-muted)", minHeight: 100 }}
    >
      {text}
    </div>
  );
}
