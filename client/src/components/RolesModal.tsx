import { useCallback, useEffect, useState } from "react";
import { api, type Role, type PublicUser } from "../api";
import { PERM_LABELS } from "../permissions";
import { ModalShell } from "./ModalShell";

type Props = {
  token: string;
  serverId: string;
  members: PublicUser[];
  ownerId: string;
  onClose: () => void;
};

/** Create roles (with permission toggles), delete them, and assign to members. */
export function RolesModal({ token, serverId, members, ownerId, onClose }: Props) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [assigned, setAssigned] = useState<Record<string, Set<string>>>({});
  const [name, setName] = useState("");
  const [perms, setPerms] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const rs = await api.listRoles(token, serverId);
      setRoles(rs);
      const entries = await Promise.all(
      members.map(
          async (m) =>
            [m.id, new Set(await api.getMemberRoles(token, serverId, m.id).catch(() => []))] as const
        )
      );
      setAssigned(Object.fromEntries(entries));
    } catch {
      setRoles([]);
      setAssigned({});
      setError("Roles could not load. Check your connection and try again.");
    }
  }, [token, serverId, members]);

  // Re-fetch when the token rotates or the target server/member set changes mid-open.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.createRole(token, serverId, name.trim(), perms);
      setName("");
      setPerms(0);
      await refresh();
    } catch {
      setError("Could not create that role. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function del(roleId: string) {
    try {
      setError(null);
      await api.deleteRole(token, serverId, roleId);
      await refresh();
    } catch {
      setError("Could not delete that role. Try again.");
    }
  }

  async function toggleAssign(userId: string, roleId: string, has: boolean) {
    try {
      setError(null);
      if (has) await api.unassignRole(token, serverId, userId, roleId);
      else await api.assignRole(token, serverId, userId, roleId);
      await refresh();
    } catch {
      setError("Could not update that member’s role. Try again.");
    }
  }

  const assignable = members.filter((m) => m.id !== ownerId);

  return (
    <ModalShell onClose={onClose} labelledBy="kc-roles-title" maxWidthClass="max-w-lg">
      <h2
        id="kc-roles-title"
        style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-2xl)", color: "var(--text-primary)" }}
      >
        Roles & permissions
      </h2>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        Hand out exactly the powers you want — nothing more.
      </p>

      {/* Create a role */}
      <form onSubmit={handleCreate} className="mt-4">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New role name (e.g. Moderator)"
          aria-label="Role name"
          maxLength={32}
          className="kc-field w-full px-3.5 py-2.5 text-sm outline-none"
        />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {PERM_LABELS.map((p) => {
            const on = (perms & p.flag) !== 0;
            return (
              <button
                key={p.flag}
                type="button"
                onClick={() => setPerms((cur) => (on ? cur & ~p.flag : cur | p.flag))}
                title={p.hint}
                aria-pressed={on}
                className="kc-interactive kc-perm-chip px-2.5 py-1 text-xs font-semibold"
                style={{
                  borderRadius: "var(--radius-full)",
                  border: `1px solid ${on ? "var(--accent)" : "var(--bg-hover)"}`,
                  background: on ? "color-mix(in oklch, var(--accent) 14%, transparent)" : "var(--bg-input)",
                  color: on ? "var(--accent)" : "var(--text-secondary)",
                }}
              >
                {on ? "✓ " : "○ "}{p.label}
              </button>
            );
          })}
        </div>
        <button
          type="submit"
          disabled={!name.trim() || busy}
          className="kc-cta mt-2 px-4 py-2 text-sm"
          style={{ opacity: !name.trim() || busy ? 0.65 : 1 }}
        >
          Create role
        </button>
      </form>

      {error && (
        <div role="alert" className="mt-3 rounded-xl px-3 py-2 text-sm" style={{ background: "color-mix(in oklch, var(--danger) 12%, var(--bg-elevated))", color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {/* Existing roles + assignment */}
      <div className="mt-5" style={{ maxHeight: 320, overflowY: "auto" }}>
        {roles.length === 0 ? (
          <p className="text-center text-sm" style={{ color: "var(--text-muted)", padding: "var(--space-4)" }}>
            No roles yet. Create one above to start delegating.
          </p>
        ) : (
          roles.map((r) => (
            <div key={r.id} className="mb-3" style={{ borderTop: "1px solid var(--bg-input)", paddingTop: "var(--space-3)" }}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold" style={{ color: r.color ?? "var(--text-primary)" }}>{r.name}</span>
                <button
                  type="button"
                  onClick={() => del(r.id)}
                  className="kc-interactive text-xs font-semibold"
                  style={{ color: "var(--danger)", background: "none", border: "none", cursor: "pointer" }}
                >
                  Delete role
                </button>
              </div>
              <div className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
                {PERM_LABELS.filter((p) => (r.permissions & p.flag) !== 0).map((p) => p.label).join(" · ") || "No permissions"}
              </div>
              {/* assign to members */}
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {assignable.map((m) => {
                  const has = assigned[m.id]?.has(r.id) ?? false;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => toggleAssign(m.id, r.id, has)}
                      className="kc-interactive px-2 py-0.5 text-xs font-semibold"
                      style={{
                        borderRadius: "var(--radius-full)",
                        border: `1px solid ${has ? "var(--green)" : "var(--bg-hover)"}`,
                        background: has ? "color-mix(in oklch, var(--green) 16%, transparent)" : "transparent",
                        color: has ? "var(--green)" : "var(--text-muted)",
                      }}
                    >
                      {has ? "✓ " : "+ "}{m.display_name}
                    </button>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </ModalShell>
  );
}
