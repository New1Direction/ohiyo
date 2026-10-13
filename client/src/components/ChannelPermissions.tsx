import { useState } from "react";
import type { PublicUser, Role } from "../api";
import { PERM } from "../permissions";
import {
  isPrivateChannel,
  overwriteState,
  paintRoleColor,
  withOverwriteState,
  type OverwriteBits,
  type OverwriteRow,
  type OverwriteState,
} from "../lib/roleColors";
import "./roles.css";

type Props = {
  channelName: string;
  overwrites: OverwriteRow[];
  roles: Role[];
  members: PublicUser[];
  /** The editor's own permissions here: what they lack, they can't allow or deny. */
  myPermissions: number;
  onSet: (targetType: string, targetId: string | null, bits: OverwriteBits) => Promise<void>;
  onRemove: (targetType: string, targetId: string | null) => Promise<void>;
  /** Drop this channel's own permissions and follow its category's. Only for a channel in one. */
  onSync?: () => Promise<void>;
};

// The permissions a channel can set for itself, with what they mean here.
const CHANNEL_PERMS: { flag: number; label: string; hint: string }[] = [
  { flag: PERM.VIEW_CHANNEL, label: "View channels", hint: "See this channel and read it." },
  { flag: PERM.SEND_MESSAGES, label: "Send messages", hint: "Post here." },
  { flag: PERM.MANAGE_MESSAGES, label: "Manage messages", hint: "Delete anyone's messages here and pin them." },
  { flag: PERM.MANAGE_CHANNELS, label: "Manage channels", hint: "Rename this channel and change its topic." },
  { flag: PERM.MANAGE_ROLES, label: "Manage roles", hint: "Change these permissions." },
  { flag: PERM.CREATE_INVITE, label: "Create invites", hint: "Make invite links from here." },
];

const STATES: { state: OverwriteState; label: string; mark: string }[] = [
  { state: "allow", label: "Allow", mark: "✓" },
  { state: "inherit", label: "Inherit", mark: "/" },
  { state: "deny", label: "Deny", mark: "✕" },
];

type Target = { type: string; id: string | null; name: string; color?: string | null };

const NO_BITS: OverwriteBits = { allow: 0, deny: 0 };

/** A channel's own permissions: a private switch, and allow / inherit / deny per role or member. */
export function ChannelPermissions({ channelName, overwrites, roles, members, myPermissions, onSet, onRemove, onSync }: Props) {
  // Rows picked to edit that don't have permissions of their own yet.
  const [added, setAdded] = useState<{ type: string; id: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isAdmin = (myPermissions & PERM.ADMINISTRATOR) !== 0;
  const mayChange = (flag: number) => isAdmin || (myPermissions & flag) !== 0;
  const isPrivate = isPrivateChannel(overwrites);

  const bitsFor = (type: string, id: string | null): OverwriteBits => {
    const row = overwrites.find((o) => o.target_type === type && (o.target_id ?? null) === id);
    return row ? { allow: row.allow, deny: row.deny } : NO_BITS;
  };
  const rolesById = new Map(roles.map((r) => [r.id, r]));
  const membersById = new Map(members.map((m) => [m.id, m]));
  const listed = [
    ...overwrites.filter((o) => o.target_type !== "everyone").map((o) => ({ type: o.target_type, id: o.target_id ?? "" })),
    ...added.filter((a) => !overwrites.some((o) => o.target_type === a.type && o.target_id === a.id)),
  ];
  const targets: Target[] = [
    { type: "everyone", id: null, name: "@everyone" },
    ...listed.flatMap((t): Target[] => {
      if (t.type === "role") {
        const role = rolesById.get(t.id);
        return role ? [{ type: "role", id: role.id, name: role.name, color: role.color }] : [];
      }
      const member = membersById.get(t.id);
      return member ? [{ type: "member", id: member.id, name: member.display_name }] : [];
    }),
  ];
  const rolesToAdd = roles.filter((r) => !r.is_everyone && !listed.some((t) => t.type === "role" && t.id === r.id));
  const membersToAdd = members.filter((m) => !listed.some((t) => t.type === "member" && t.id === m.id));

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Couldn't change that. Try again?");
    } finally {
      setBusy(false);
    }
  }

  function setState(target: Target, flag: number, state: OverwriteState) {
    void run(() => onSet(target.type, target.id, withOverwriteState(bitsFor(target.type, target.id), flag, state)));
  }

  function togglePrivate() {
    const next = withOverwriteState(bitsFor("everyone", null), PERM.VIEW_CHANNEL, isPrivate ? "inherit" : "deny");
    void run(() => onSet("everyone", null, next));
  }

  function addTarget(type: "role" | "member", id: string) {
    if (!id) return;
    setAdded((prev) => [...prev, { type, id }]);
    // In a private channel, picking someone is letting them in.
    if (isPrivate) void run(() => onSet(type, id, withOverwriteState(bitsFor(type, id), PERM.VIEW_CHANNEL, "allow")));
  }

  function removeTarget(target: Target) {
    setAdded((prev) => prev.filter((a) => !(a.type === target.type && a.id === target.id)));
    void run(() => onRemove(target.type, target.id));
  }

  return (
    <div className="kc-channel-perms" aria-busy={busy}>
      <div className="kc-channel-perms__private">
        <div>
          <div className="kc-role-option__name">Private channel</div>
          <div className="kc-role-option__hint">
            {isPrivate
              ? `Only the roles and members you let in can see #${channelName}.`
              : `Everyone in the space can see #${channelName}. Make it private to choose who can.`}
          </div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={isPrivate}
          aria-label="Private channel"
          disabled={busy || !mayChange(PERM.VIEW_CHANNEL)}
          onClick={togglePrivate}
          className="kc-switch"
        >
          <span className="kc-switch__knob" aria-hidden />
        </button>
      </div>

      <div className="kc-channel-perms__add">
        <select
          aria-label={isPrivate ? "Let a role in" : "Add a role"}
          value=""
          onChange={(e) => addTarget("role", e.target.value)}
          disabled={busy || rolesToAdd.length === 0}
          className="kc-field kc-notif-select px-3 text-sm"
        >
          <option value="">{isPrivate ? "Let a role in…" : "Set permissions for a role…"}</option>
          {rolesToAdd.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        <select
          aria-label={isPrivate ? "Let a member in" : "Add a member"}
          value=""
          onChange={(e) => addTarget("member", e.target.value)}
          disabled={busy || membersToAdd.length === 0}
          className="kc-field kc-notif-select px-3 text-sm"
        >
          <option value="">{isPrivate ? "Let a member in…" : "Set permissions for a member…"}</option>
          {membersToAdd.map((m) => (
            <option key={m.id} value={m.id}>
              {m.display_name}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <p role="alert" className="kc-role-editor__note is-error">
          {error}
        </p>
      )}

      {targets.map((target) => {
        const bits = bitsFor(target.type, target.id);
        return (
          <section key={`${target.type}:${target.id ?? ""}`} className="kc-channel-perms__target" aria-label={target.name}>
            <header className="kc-channel-perms__head">
              <span className="kc-channel-perms__name" style={{ color: target.color ? paintRoleColor(target.color) : undefined }}>
                {target.type === "member" ? `@${target.name}` : target.name}
              </span>
              {target.type !== "everyone" && (
                <button
                  type="button"
                  className="kc-channel-perms__remove"
                  aria-label={`Remove ${target.name}`}
                  disabled={busy}
                  onClick={() => removeTarget(target)}
                >
                  Remove
                </button>
              )}
            </header>
            {CHANNEL_PERMS.map((p) => {
              const current = overwriteState(bits, p.flag);
              const locked = busy || !mayChange(p.flag);
              return (
                <div key={p.flag} className="kc-channel-perms__row">
                  <div className="min-w-0">
                    <div className="kc-role-option__name">{p.label}</div>
                    <div className="kc-role-option__hint">{p.hint}</div>
                  </div>
                  <div className="kc-tristate" role="group" aria-label={`${target.name} · ${p.label}`}>
                    {STATES.map((s) => (
                      <button
                        key={s.state}
                        type="button"
                        aria-label={`${target.name} · ${p.label}: ${s.label}`}
                        aria-pressed={current === s.state}
                        title={s.label}
                        disabled={locked}
                        onClick={() => current !== s.state && setState(target, p.flag, s.state)}
                        className={`kc-tristate__btn is-${s.state}`}
                      >
                        {s.mark}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
          </section>
        );
      })}

      {onSync && (
        <div className="kc-channel-perms__sync">
          <span className="kc-role-option__hint">Drop this channel&apos;s own permissions and follow its category&apos;s.</span>
          <button type="button" className="kc-notif-cancel" disabled={busy} onClick={() => {
              if (onSync) void run(onSync);
            }}>
            Sync with category
          </button>
        </div>
      )}
    </div>
  );
}
