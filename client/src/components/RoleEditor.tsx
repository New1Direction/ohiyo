import { useId, useState } from "react";
import type { Role } from "../api";
import { PERM } from "../permissions";
import { contrastRatio, isValidRoleColor, paintRoleColor } from "../lib/roleColors";
import "./roles.css";

export type RolePatch = { name: string; color: string | null; permissions: number; hoist: boolean };

type Props = {
  role: Role;
  /** The editor's own permissions in the space: they can't hand out what they don't have. */
  myPermissions: number;
  onSave: (patch: RolePatch) => Promise<void>;
  onCancel: () => void;
};

export const ROLE_PALETTE: { name: string; hex: string }[] = [
  { name: "Teal", hex: "#1abc9c" },
  { name: "Green", hex: "#2ecc71" },
  { name: "Blue", hex: "#3498db" },
  { name: "Purple", hex: "#9b59b6" },
  { name: "Pink", hex: "#e91e63" },
  { name: "Yellow", hex: "#f1c40f" },
  { name: "Orange", hex: "#e67e22" },
  { name: "Red", hex: "#e74c3c" },
  { name: "Grey", hex: "#95a5a6" },
  { name: "Slate", hex: "#607d8b" },
];

// Plain words for what each permission lets someone do, grouped the way people look for them.
const GROUPS: { title: string; perms: { flag: number; label: string; hint: string }[] }[] = [
  {
    title: "Space",
    perms: [
      { flag: PERM.VIEW_CHANNEL, label: "View channels", hint: "See channels and read what's in them, unless a channel says otherwise." },
      { flag: PERM.MANAGE_CHANNELS, label: "Manage channels", hint: "Create, rename and delete channels, and set slowmode." },
      { flag: PERM.MANAGE_ROLES, label: "Manage roles", hint: "Create and edit roles below their own, and give them out." },
      { flag: PERM.MANAGE_SERVER, label: "Manage server", hint: "Rename the space, change its logo, and set up webhooks." },
      { flag: PERM.CREATE_INVITE, label: "Create invites", hint: "Make invite links so friends can join." },
    ],
  },
  {
    title: "Messages",
    perms: [
      { flag: PERM.SEND_MESSAGES, label: "Send messages", hint: "Post in text channels." },
      { flag: PERM.MANAGE_MESSAGES, label: "Manage messages", hint: "Delete anyone's messages and pin them." },
    ],
  },
  {
    title: "Members",
    perms: [
      { flag: PERM.KICK_MEMBERS, label: "Kick members", hint: "Remove someone from the space. They can come back with an invite." },
      { flag: PERM.BAN_MEMBERS, label: "Ban members", hint: "Remove someone and stop them coming back." },
      { flag: PERM.MODERATE_MEMBERS, label: "Time out members", hint: "Stop someone posting, reacting or talking for a while." },
    ],
  },
  {
    title: "Advanced",
    perms: [{ flag: PERM.ADMINISTRATOR, label: "Administrator", hint: "Every permission, everywhere, whatever channels say." }],
  },
];

// Representative chat backgrounds of the dark and light themes, for the readability check.
const DARK_BACKGROUND = "#22211f";
const LIGHT_BACKGROUND = "#ffffff";
const MIN_NAME_CONTRAST = 3;

/** Edit a role: its name, colour, permissions and whether it's listed on its own. */
export function RoleEditor({ role, myPermissions, onSave, onCancel }: Props) {
  const titleId = useId();
  const everyone = Boolean(role.is_everyone);
  const isAdmin = (myPermissions & PERM.ADMINISTRATOR) !== 0;
  const [name, setName] = useState(role.name);
  const [color, setColor] = useState<string | null>(role.color);
  const [customColor, setCustomColor] = useState(role.color ?? "");
  const [permissions, setPermissions] = useState(role.permissions);
  const [hoist, setHoist] = useState(Boolean(role.hoist));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  const customValid = customColor === "" || isValidRoleColor(customColor);
  const hardToRead = color
    ? [
        contrastRatio(color, DARK_BACKGROUND) < MIN_NAME_CONTRAST ? "dark" : null,
        contrastRatio(color, LIGHT_BACKGROUND) < MIN_NAME_CONTRAST ? "light" : null,
      ].filter(Boolean)
    : [];

  function pickColor(hex: string | null) {
    setSaved(false);
    setColor(hex);
    setCustomColor(hex ?? "");
  }

  function typeColor(value: string) {
    setSaved(false);
    const typed = value.trim();
    const withHash = typed && !typed.startsWith("#") ? `#${typed}` : typed;
    setCustomColor(withHash);
    if (isValidRoleColor(withHash)) setColor(withHash.toLowerCase());
    else if (withHash === "") setColor(null);
  }

  function toggle(flag: number) {
    setSaved(false);
    setPermissions((cur) => cur ^ flag);
  }

  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy || !name.trim() || !customValid) return;
    setBusy(true);
    setError("");
    try {
      await onSave({ name: name.trim(), color, permissions, hoist });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Couldn't save the role. Try again?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="kc-role-editor" onSubmit={save} aria-labelledby={titleId}>
      <h3 id={titleId} className="kc-role-editor__title">
        Edit role <span style={{ color: color ? paintRoleColor(color) : undefined }}>{everyone ? "@everyone" : role.name}</span>
      </h3>

      <label className="kc-role-editor__field">
        <span className="kc-role-editor__legend">Name</span>
        <input
          value={everyone ? "@everyone" : name}
          onChange={(e) => {
            setSaved(false);
            setName(e.target.value);
          }}
          aria-label="Role name"
          maxLength={32}
          disabled={everyone}
          className="kc-field w-full px-3.5 py-2.5 text-sm outline-none"
        />
      </label>

      {!everyone && (
        <fieldset className="kc-role-editor__group">
          <legend className="kc-role-editor__legend">Colour</legend>
          <div className="kc-role-swatches">
            <button
              type="button"
              className="kc-role-swatch kc-role-swatch--none"
              aria-label="No colour"
              aria-pressed={color === null}
              onClick={() => pickColor(null)}
            />
            {ROLE_PALETTE.map((c) => (
              <button
                key={c.hex}
                type="button"
                className="kc-role-swatch"
                style={{ background: c.hex }}
                aria-label={`Colour ${c.name}`}
                aria-pressed={color === c.hex}
                onClick={() => pickColor(c.hex)}
              />
            ))}
          </div>
          <div className="kc-role-editor__custom">
            <input
              type="color"
              aria-label="Pick a colour"
              value={color ?? "#95a5a6"}
              onChange={(e) => pickColor(e.target.value.toLowerCase())}
              className="kc-role-picker"
            />
            <input
              value={customColor}
              onChange={(e) => typeColor(e.target.value)}
              aria-label="Custom colour"
              aria-invalid={!customValid}
              placeholder="#3fa7ff"
              maxLength={7}
              spellCheck={false}
              className="kc-field px-3 py-2 text-sm outline-none"
            />
            <span className="kc-role-editor__preview" style={{ color: color ? paintRoleColor(color) : "var(--text-primary)" }}>
              {name.trim() || role.name}
            </span>
          </div>
          {!customValid && <p className="kc-role-editor__note is-error">Use a colour like #3fa7ff.</p>}
          {hardToRead.length > 0 && (
            <p className="kc-role-editor__note">
              Hard to read on {hardToRead.join(" and ")} themes; names are softened toward the text colour to help.
            </p>
          )}
        </fieldset>
      )}

      {!everyone && (
        <label className="kc-role-option">
          <input
            type="checkbox"
            checked={hoist}
            onChange={() => {
              setSaved(false);
              setHoist((h) => !h);
            }}
          />
          <span className="kc-role-option__name">Show members separately in the member list</span>
          <span className="kc-role-option__hint">People with this role get their own section, above everyone else.</span>
        </label>
      )}

      {GROUPS.map((group) => (
        <fieldset key={group.title} className="kc-role-editor__group">
          <legend className="kc-role-editor__legend">{group.title}</legend>
          {group.perms.map((p) => {
            const lacks = !isAdmin && (myPermissions & p.flag) === 0;
            return (
              <label key={p.flag} className={lacks ? "kc-role-option is-locked" : "kc-role-option"}>
                <input type="checkbox" checked={(permissions & p.flag) !== 0} disabled={lacks} onChange={() => toggle(p.flag)} />
                <span className="kc-role-option__name">{p.label}</span>
                <span className="kc-role-option__hint">{lacks ? "You don't have this yourself, so you can't change it." : p.hint}</span>
              </label>
            );
          })}
        </fieldset>
      ))}

      {(permissions & PERM.ADMINISTRATOR) !== 0 && (
        <p role="alert" className="kc-role-editor__warning">
          Members with this role can do everything, in every channel, whatever else is set here. Give it only to people
          you trust completely.
        </p>
      )}

      {error && (
        <p role="alert" className="kc-role-editor__note is-error">
          {error}
        </p>
      )}

      <div className="kc-role-editor__actions">
        <span role="status" className="kc-role-editor__saved">
          {saved ? "Saved ✓" : ""}
        </span>
        <button type="button" onClick={onCancel} className="kc-notif-cancel">
          {saved ? "Done" : "Cancel"}
        </button>
        <button type="submit" disabled={busy || !name.trim() || !customValid} className="kc-cta px-4 py-2 text-sm">
          {busy ? "Saving…" : "Save changes"}
        </button>
      </div>
    </form>
  );
}
