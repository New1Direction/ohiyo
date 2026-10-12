import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./Icon";
import type { PublicUser } from "../api";
import type { ConnectionStatus, Activity } from "../gateway";
import { AvatarMark } from "./BirdMark";
import { OnlineDot, STATUS_META } from "./presence";

// Set through backgroundImage (not the `background` shorthand): React clears backgroundImage
// to "" when there is no picture, which would wipe a gradient set by the shorthand.
const AVATAR_FALLBACK_BG = "linear-gradient(135deg, var(--text-primary), var(--text-muted))";

const ACTIVITY_KINDS = [
  { kind: "playing", icon: "🎮", verb: "Playing" },
  { kind: "watching", icon: "📺", verb: "Watching" },
  { kind: "working", icon: "💼", verb: "Working on" },
  { kind: "listening", icon: "🎧", verb: "Listening to" },
] as const;

function describeActivity(activity: Activity): string {
  const meta = ACTIVITY_KINDS.find((k) => k.kind === activity.kind);
  return `${meta?.icon ?? "•"} ${meta?.verb ?? ""} ${activity.name}`.replace(/\s+/g, " ").trim();
}

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

/** Who you are, at the foot of the channel sidebar: two lines, your name and then your
 *  status, like Discord's. Status, activity and signing out are in the menu that opens from
 *  it; Settings stays one click away beside it. */
export function UserPanel({
  currentUser, connStatus, myStatus, onSetStatus, myActivity, onSetActivity, privacyMode, onLogout, onOpenSettings,
}: Props) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selfOnline = connStatus === "connected";
  const activityText = myActivity && !privacyMode ? describeActivity(myActivity) : null;
  const secondLine = myStatus || (selfOnline ? activityText || "Set a status" : STATUS_META[connStatus].label);
  const secondLineMuted = !myStatus && !(selfOnline && activityText);

  const close = (returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  };

  // A click anywhere outside the panel closes the menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  return (
    <div
      ref={panelRef}
      className="kc-user-panel relative flex items-center gap-1.5 px-2 py-2"
      style={{ background: "var(--bg-base)", borderTop: "1px solid color-mix(in oklch, var(--text-primary) 6%, transparent)" }}
    >
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Your status"
        className="kc-user-identity kc-interactive flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <span className="kc-user-avatar-wrap relative flex-shrink-0">
          <span
            className="kc-user-avatar flex h-9 w-9 items-center justify-center rounded-full text-xs font-bold"
            style={{
              color: "var(--bg-base)",
              boxShadow: "0 0 0 2px color-mix(in oklch, var(--accent) 22%, transparent)",
              backgroundImage: currentUser.avatar_url ? `url(${currentUser.avatar_url})` : AVATAR_FALLBACK_BG,
              backgroundSize: "cover", backgroundPosition: "center",
            }}
          >
            {!currentUser.avatar_url && <AvatarMark />}
          </span>
          <OnlineDot color={selfOnline ? "var(--green)" : "#E8A23D"} />
        </span>
        <span className="kc-user-lines flex min-w-0 flex-1 flex-col leading-tight">
          <span className="flex min-w-0 items-center gap-1">
            <span data-user-line className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              {currentUser.display_name}
            </span>
            {privacyMode && (
              <span className="kc-user-ghost flex-shrink-0" title="Privacy Mode is on: presence, typing, activity and seen receipts are hidden." aria-label="Privacy Mode is on">
                👻
              </span>
            )}
          </span>
          <span
            data-user-line
            className="kc-user-status truncate text-xs"
            style={{ color: secondLineMuted ? "var(--text-muted)" : "var(--text-secondary)" }}
          >
            {secondLine}
          </span>
        </span>
      </button>
      <button
        type="button"
        onClick={onOpenSettings}
        aria-label="Settings"
        title="Settings (Ctrl+,)"
        className="kc-sidebar-action kc-interactive flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full text-base"
        style={{ color: "var(--text-muted)", background: "transparent", border: "none" }}
      >
        <Icon name="settings" size={16} />
      </button>
      {open && (
        <UserMenu
          myStatus={myStatus ?? null}
          onSetStatus={onSetStatus}
          myActivity={myActivity ?? null}
          onSetActivity={onSetActivity}
          privacyMode={Boolean(privacyMode)}
          onSignOut={() => {
            close(false);
            onLogout();
          }}
          onClose={() => close(true)}
        />
      )}
    </div>
  );
}

function UserMenu({
  myStatus, onSetStatus, myActivity, onSetActivity, privacyMode, onSignOut, onClose,
}: {
  myStatus: string | null;
  onSetStatus?: (status: string) => void;
  myActivity: Activity | null;
  onSetActivity?: (activity: Activity | null) => void;
  privacyMode: boolean;
  onSignOut: () => void;
  onClose: () => void;
}) {
  const [addingActivity, setAddingActivity] = useState(false);
  const statusId = useId();
  const menuRef = useRef<HTMLDivElement>(null);
  const statusRef = useRef<HTMLInputElement>(null);
  const kindRef = useRef<HTMLSelectElement>(null);
  const activityNameRef = useRef<HTMLInputElement>(null);

  // Open on the status field (or the menu itself when status can't be set); "Add an
  // activity" moves to the activity name.
  useEffect(() => {
    (statusRef.current ?? menuRef.current)?.focus();
  }, []);
  useEffect(() => {
    if (addingActivity) activityNameRef.current?.focus();
  }, [addingActivity]);

  const saveStatus = (value: string) => {
    onSetStatus?.(value.trim());
    onClose();
  };
  const saveActivity = () => {
    const name = activityNameRef.current?.value.trim() ?? "";
    if (name) onSetActivity?.({ kind: kindRef.current?.value ?? "playing", name });
    setAddingActivity(false);
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- popover dialog; Escape closes it and gives focus back to the bar
    <div
      ref={menuRef}
      role="dialog"
      aria-label="Your status"
      tabIndex={-1}
      className="kc-user-menu"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      {onSetStatus && (
        <div className="kc-user-menu__section">
          <label className="kc-user-menu__label" htmlFor={statusId}>Status</label>
          <input
            id={statusId}
            ref={statusRef}
            aria-label="Status"
            defaultValue={myStatus ?? ""}
            maxLength={80}
            placeholder="What's up?"
            className="kc-user-menu__field"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                saveStatus(e.currentTarget.value);
              }
            }}
          />
          {myStatus && (
            <button type="button" className="kc-user-menu__item kc-interactive" onClick={() => saveStatus("")}>
              Clear status
            </button>
          )}
        </div>
      )}
      {privacyMode ? (
        <p className="kc-user-menu__note">
          <span aria-hidden="true">👻</span> Privacy Mode is on, so no activity is shown to anyone.
        </p>
      ) : onSetActivity ? (
        <div className="kc-user-menu__section">
          {addingActivity ? (
            <div className="kc-user-menu__activity">
              <select ref={kindRef} defaultValue="playing" aria-label="Activity type" className="kc-user-menu__field">
                {ACTIVITY_KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>{k.icon} {k.verb}</option>
                ))}
              </select>
              <input
                ref={activityNameRef}
                aria-label="Activity name"
                maxLength={128}
                placeholder="What are you up to?"
                className="kc-user-menu__field"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    saveActivity();
                  }
                }}
              />
            </div>
          ) : myActivity ? (
            <div className="kc-user-menu__current">
              <span className="truncate">{describeActivity(myActivity)}</span>
              <button type="button" className="kc-user-menu__item kc-interactive" onClick={() => onSetActivity?.(null)}>
                Clear activity
              </button>
            </div>
          ) : (
            <button type="button" className="kc-user-menu__item kc-interactive" onClick={() => setAddingActivity(true)}>
              Add an activity
            </button>
          )}
        </div>
      ) : null}
      <div className="kc-user-menu__section kc-user-menu__section--end">
        <button type="button" className="kc-user-menu__item kc-interactive" title="Sign out" onClick={onSignOut}>
          Sign out…
        </button>
      </div>
    </div>
  );
}
