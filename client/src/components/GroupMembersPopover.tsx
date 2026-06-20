import { useEffect, useMemo, useState } from "react";
import type { Channel, PublicUser } from "../api";
import { api } from "../api";

type Props = {
  channel: Channel;
  currentUserId: string;
  token: string;
  /** Live participant list from the gateway (preferred); else we fetch on open. */
  seedMembers?: PublicUser[];
  onOpenDm?: (user: PublicUser) => void | Promise<void>;
  onToast: (text: string, type?: "info" | "success" | "error") => void;
  onClose: () => void;
};

const label = (u: PublicUser) => u.display_name || u.username;

function Avatar({ user, small }: { user: PublicUser; small?: boolean }) {
  return (
    <span
      className={small ? "kc-grpmem__avatar kc-grpmem__avatar--sm" : "kc-grpmem__avatar"}
      style={{ backgroundImage: user.avatar_url ? `url(${user.avatar_url})` : undefined }}
      aria-hidden
    >
      {!user.avatar_url && (label(user)[0] ?? "?").toUpperCase()}
    </span>
  );
}

/**
 * Group-DM member management. Lists participants; the owner can remove anyone, anyone
 * can add people or leave. Every add/remove bumps the server's rekey epoch, so the
 * client crypto rotates sender keys automatically — this UI just drives the endpoints.
 */
export function GroupMembersPopover({ channel, currentUserId, token, seedMembers, onOpenDm, onToast, onClose }: Props) {
  const [members, setMembers] = useState<PublicUser[]>(seedMembers ?? []);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PublicUser[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isOwner = !!channel.owner_id && channel.owner_id === currentUserId;

  // Prefer the live list from App; otherwise pull the authoritative one once.
  useEffect(() => {
    if (seedMembers) {
      setMembers(seedMembers);
      return;
    }
    let alive = true;
    api
      .listRecipients(token, channel.id)
      .then((m) => alive && setMembers(m))
      .catch(() => alive && setError("Could not load group members. Try again."));
    return () => {
      alive = false;
    };
  }, [seedMembers, token, channel.id]);

  // Debounced people search for "Add people", filtered to non-members.
  const memberIds = useMemo(() => new Set(members.map((m) => m.id)), [members]);
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setError(null);
      return;
    }
    let alive = true;
    const t = setTimeout(() => {
      api
        .searchUsers(token, q)
        .then((found) => {
          if (!alive) return;
          setError(null);
          setResults(found.filter((u) => !memberIds.has(u.id)));
        })
        .catch(() => alive && setError("Could not search people. Try again."));
    }, 220);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [query, token, memberIds]);

  async function add(user: PublicUser) {
    setBusy(true);
    try {
      await api.addRecipient(token, channel.id, user.id);
      setMembers((prev) => (prev.some((m) => m.id === user.id) ? prev : [...prev, user]));
      setQuery("");
      setResults([]);
      onToast(`Added ${label(user)}`, "success");
    } catch {
      onToast("Couldn't add them — try again", "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(user: PublicUser) {
    setBusy(true);
    try {
      await api.removeRecipient(token, channel.id, user.id);
      setMembers((prev) => prev.filter((m) => m.id !== user.id));
      onToast(`Removed ${label(user)}`, "success");
    } catch {
      onToast("Couldn't remove them — only the group owner can", "error");
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    setBusy(true);
    try {
      await api.removeRecipient(token, channel.id, currentUserId);
      onToast("You left the group", "info");
      onClose(); // the gateway GroupMembersUpdate drops the channel from the list
    } catch {
      onToast("Couldn't leave — try again", "error");
      setBusy(false);
    }
  }

  // Owner first, then everyone else.
  const ordered = useMemo(
    () => [...members].sort((a, b) => (a.id === channel.owner_id ? 0 : 1) - (b.id === channel.owner_id ? 0 : 1)),
    [members, channel.owner_id],
  );

  return (
    <div className="kc-grpmem" role="dialog" aria-label="Group members">
      <header className="kc-grpmem__head">
        <span>
          Members <span className="kc-grpmem__count">{members.length}</span>
        </span>
        <button type="button" className="kc-grpmem__x" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>

      {error && <div className="kc-grpmem__empty" role="alert">{error}</div>}

      <ul className="kc-grpmem__list">
        {ordered.length === 0 ? (
          <li className="kc-grpmem__empty">No members loaded yet.</li>
        ) : ordered.map((m) => {
          const isMe = m.id === currentUserId;
          const isGroupOwner = m.id === channel.owner_id;
          return (
            <li key={m.id} className="kc-grpmem__row">
              <Avatar user={m} />
              <span className="kc-grpmem__name">
                {label(m)}
                {isMe && <span className="kc-grpmem__tag">you</span>}
                {isGroupOwner && <span className="kc-grpmem__tag kc-grpmem__tag--owner">owner</span>}
              </span>
              {onOpenDm && !isMe && (
                <button
                  type="button"
                  className="kc-grpmem__message"
                  aria-label={`Message ${label(m)}`}
                  title="Message"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await onOpenDm(m);
                      onClose();
                    } catch {
                      setBusy(false);
                    }
                  }}
                >
                  💬
                </button>
              )}
              {isOwner && !isMe && (
                <button
                  type="button"
                  className="kc-grpmem__remove"
                  aria-label={`Remove ${label(m)}`}
                  title="Remove from group"
                  disabled={busy}
                  onClick={() => remove(m)}
                >
                  ×
                </button>
              )}
            </li>
          );
        })}
      </ul>

      <div className="kc-grpmem__add">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Add people by username…"
          aria-label="Add people to the group"
          disabled={busy}
        />
        {query.trim().length >= 2 && !error && results.length === 0 && (
          <div className="kc-grpmem__empty">No people found.</div>
        )}
        {results.length > 0 && (
          <ul className="kc-grpmem__results">
            {results.slice(0, 6).map((u) => (
              <li key={u.id}>
                <button type="button" disabled={busy} onClick={() => add(u)}>
                  <Avatar user={u} small />
                  <span className="kc-grpmem__rname">{label(u)}</span>
                  <span className="kc-grpmem__handle">@{u.username}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="kc-grpmem__foot">
        <button type="button" className="kc-grpmem__leave" disabled={busy} onClick={leave}>
          Leave group
        </button>
      </footer>
    </div>
  );
}
