import { useRef, useState } from "react";
import { Icon } from "./Icon";
import type { PublicUser } from "../api";
import type { ConnectionStatus, Activity } from "../gateway";
import { AvatarMark } from "./BirdMark";
import { OnlineDot, STATUS_META } from "./presence";

// Set through backgroundImage (not the `background` shorthand): React clears backgroundImage
// to "" when there is no picture, which would wipe a gradient set by the shorthand.
const AVATAR_FALLBACK_BG = "linear-gradient(135deg, var(--text-primary), var(--text-muted))";

type Props = {
  currentUser: PublicUser;
  connStatus: ConnectionStatus;
  myStatus?: string | null;
  onSetStatus?: (status: string) => void;
  myActivity?: Activity | null;
  onSetActivity?: (activity: Activity | null) => void;
  privacyMode?: boolean;
  onLogout: () => void;
  onOpenSettings: () => void;
};

/** Who you are, at the foot of the channel sidebar: your status, activity and settings. */
export function UserPanel({
  currentUser, connStatus, myStatus, onSetStatus, myActivity, onSetActivity, privacyMode, onLogout, onOpenSettings,
}: Props) {
  const [editingStatus, setEditingStatus] = useState(false);
  // Guards the status input's onBlur from re-saving after Enter, or saving on Escape.
  const statusHandledRef = useRef(false);
  const selfOnline = connStatus === "connected";
  return (
    <div
      className="kc-user-panel flex items-center gap-2.5 px-2 py-3"
      style={{ background: "var(--bg-base)", borderTop: "1px solid color-mix(in oklch, var(--text-primary) 6%, transparent)" }}
    >
      <button
        type="button"
        onClick={() => onSetStatus && setEditingStatus(true)}
        className="kc-user-avatar-btn relative flex-shrink-0"
        style={{ border: "none", background: "transparent", padding: 0, cursor: onSetStatus ? "pointer" : "default" }}
        aria-label="Edit status"
        title="Edit status"
      >
        <div
          className="flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold"
          style={{
            color: "var(--bg-base)",
            boxShadow: "0 0 0 2px color-mix(in oklch, var(--accent) 22%, transparent)",
            backgroundImage: currentUser.avatar_url ? `url(${currentUser.avatar_url})` : AVATAR_FALLBACK_BG,
            backgroundSize: "cover", backgroundPosition: "center",
          }}
        >
          {!currentUser.avatar_url && <AvatarMark />}
        </div>
        <OnlineDot color={selfOnline ? "var(--green)" : "#E8A23D"} />
      </button>
      <div className="min-w-0 flex-1 leading-tight">
        <button
          type="button"
          onClick={() => onSetStatus && setEditingStatus(true)}
          className="kc-interactive block w-full truncate text-left text-sm font-semibold"
          style={{ color: "var(--text-primary)", background: "none", border: "none", cursor: onSetStatus ? "pointer" : "default", padding: 0 }}
          title="Edit status"
        >
          {currentUser.display_name}
        </button>
        {editingStatus ? (
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus -- inline status editor opens on user action; focusing immediately is expected
            autoFocus
            defaultValue={myStatus ?? ""}
            maxLength={80}
            placeholder="Set your vibe"
            onFocus={() => { statusHandledRef.current = false; }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                statusHandledRef.current = true; // saving now; don't re-save on blur
                onSetStatus?.((e.target as HTMLInputElement).value);
                setEditingStatus(false);
              } else if (e.key === "Escape") {
                statusHandledRef.current = true; // cancel — don't save on blur
                setEditingStatus(false);
              }
            }}
            onBlur={(e) => {
              if (!statusHandledRef.current) onSetStatus?.(e.target.value);
              setEditingStatus(false);
            }}
            className="kc-user-status-input w-full bg-transparent text-xs outline-none"
            style={{ color: "var(--text-secondary)" }}
          />
        ) : (
          <button
            type="button"
            onClick={() => onSetStatus && setEditingStatus(true)}
            className="kc-interactive kc-user-status w-full truncate text-left text-xs"
            style={{
              color: myStatus ? "var(--text-secondary)" : "var(--text-muted)",
              background: "none", border: "none",
              cursor: onSetStatus ? "pointer" : "default",
            }}
            title="Set a custom status"
          >
            {myStatus || (selfOnline ? "Set a status" : STATUS_META[connStatus].label)}
          </button>
        )}
        {privacyMode ? (
          <div className="kc-privacy-mode-badge" title="Privacy Mode is on: presence, typing, activity, and peer-visible seen receipts are hidden.">
            <span aria-hidden="true">👻</span>
            Privacy Mode
          </div>
        ) : onSetActivity ? <ActivityComposer activity={myActivity ?? null} onSet={onSetActivity} /> : null}
      </div>
      <div className="kc-user-actions flex flex-shrink-0 items-center gap-1">
        <button type="button" onClick={onOpenSettings} aria-label="Settings" className="kc-sidebar-action kc-interactive flex h-8 w-8 items-center justify-center rounded-full text-base" style={{ color: "var(--text-muted)", background: "transparent", border: "none" }} title="Settings (Ctrl+,)"><Icon name="settings" size={16} /></button>
        <button type="button" onClick={onLogout} aria-label="Sign out" className="kc-sidebar-action kc-interactive flex h-8 w-8 items-center justify-center rounded-full text-base" style={{ color: "var(--text-muted)", background: "transparent", border: "none" }} title="Sign out">⎋</button>
      </div>
    </div>
  );
}

const ACTIVITY_KINDS = [
  { kind: "playing", icon: "🎮", verb: "Playing" },
  { kind: "watching", icon: "📺", verb: "Watching" },
  { kind: "working", icon: "💼", verb: "Working on" },
  { kind: "listening", icon: "🎧", verb: "Listening to" },
] as const;

/** Inline rich-presence setter shown under the user's name in the sidebar. */
function ActivityComposer({ activity, onSet }: { activity: Activity | null; onSet: (a: Activity | null) => void }) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState("playing");
  const [name, setName] = useState("");

  if (activity && !open) {
    const meta = ACTIVITY_KINDS.find((k) => k.kind === activity.kind);
    return (
      <div className="mt-0.5 flex items-center gap-1 text-xs" style={{ color: "var(--accent)", fontWeight: 600 }}>
        <span className="truncate">{meta?.icon ?? "•"} {meta?.verb ?? ""} {activity.name}</span>
        <button
          type="button"
          onClick={() => onSet(null)}
          aria-label="Clear activity"
          title="Clear activity"
          className="kc-interactive flex-shrink-0"
          style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", lineHeight: 1 }}
        >
          ×
        </button>
      </div>
    );
  }
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="kc-interactive mt-0.5 text-left text-xs"
        style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
      >
        + Activity
      </button>
    );
  }
  const submit = () => {
    const n = name.trim();
    if (n) onSet({ kind, name: n });
    setOpen(false);
    setName("");
  };
  return (
    <div className="mt-0.5 flex items-center gap-1">
      <select
        value={kind}
        onChange={(e) => setKind(e.target.value)}
        aria-label="Activity type"
        className="bg-transparent text-xs outline-none"
        style={{ color: "var(--text-secondary)" }}
      >
        {ACTIVITY_KINDS.map((k) => (
          <option key={k.kind} value={k.kind}>{k.icon} {k.verb}</option>
        ))}
      </select>
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus -- inline composer opens on user action; focusing immediately is expected
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={128}
        placeholder="What are you up to?"
        aria-label="Activity name"
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          else if (e.key === "Escape") setOpen(false);
        }}
        onBlur={submit}
        className="w-full bg-transparent text-xs outline-none"
        style={{ color: "var(--text-secondary)" }}
      />
    </div>
  );
}
