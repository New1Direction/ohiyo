import { useCallback, useEffect, useState } from "react";
import { api, type Role, type PublicUser } from "../api";
import { PERM, PERM_LABELS } from "../permissions";
import { errorMessage } from "../lib/errorMessage";
import { moveRole, paintRoleColor } from "../lib/roleColors";
import { ModalShell } from "./ModalShell";
import { RoleEditor, type RolePatch } from "./RoleEditor";
import "./roles.css";

type Props = {
  token: string;
  serverId: string;
  members: PublicUser[];
  ownerId: string;
  currentUserId?: string;
  /** Your permissions in the space: the role editor only offers what you have. */
  myPermissions?: number;
  onClose: () => void;
};

/** Create, edit, reorder and delete roles, and assign them to members. */
export function RolesModal({ token, serverId, members, ownerId, currentUserId, myPermissions = 0, onClose }: Props) {
  const [roles, setRoles] = useState<Role[]>([]);
  const [assigned, setAssigned] = useState<Record<string, Set<string>>>({});
  const [name, setName] = useState("");
  const [perms, setPerms] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

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
    } catch (err) {
      setError(errorMessage(err, "Could not create that role. Try again."));
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

  async function saveRole(role: Role, patch: RolePatch) {
    try {
      // @everyone keeps its name and colour and is never listed on its own: only its permissions change.
      await api.updateRole(token, serverId, role.id, role.is_everyone ? { permissions: patch.permissions } : patch);
    } catch (err) {
      throw new Error(errorMessage(err, "Could not save that role. Try again."));
    }
    await refresh();
  }

  const isOwner = currentUserId === ownerId;
  const myTop = isOwner
    ? Infinity
    : Math.max(-1, ...roles.filter((r) => currentUserId && assigned[currentUserId]?.has(r.id)).map((r) => r.position));
  const ranked = [...roles].sort((a, b) => b.position - a.position);
  // The roles you can move: every role ranked below your own highest one.
  const movable = ranked.filter((r) => !r.is_everyone && r.position < myTop).map((r) => r.id);
  const canEdit = (r: Role) => r.is_everyone || r.position < myTop;

  async function reorder(order: string[]) {
    if (order.every((id, i) => id === movable[i])) return;
    // Show the new order straight away; the server's answer settles it.
    const slots = movable.map((id) => roles.find((r) => r.id === id)!.position);
    const moved = new Map(order.map((id, i) => [id, slots[i]]));
    setRoles((prev) => prev.map((r) => (moved.has(r.id) ? { ...r, position: moved.get(r.id)! } : r)));
    try {
      setError(null);
      await api.reorderRoles(token, serverId, order);
    } catch (err) {
      setError(errorMessage(err, "Could not move that role. Try again."));
    }
    await refresh();
  }

  function dropOn(targetId: string) {
    if (!dragId || dragId === targetId) return;
    const without = movable.filter((id) => id !== dragId);
    const at = without.indexOf(targetId);
    if (at < 0) return;
    const fromIndex = movable.indexOf(dragId);
    const toIndex = movable.indexOf(targetId);
    // Dropped on a lower role: it goes below it; on a higher one: above it.
    const insertAt = fromIndex < toIndex ? at + 1 : at;
    void reorder([...without.slice(0, insertAt), dragId, ...without.slice(insertAt)]);
  }

  const assignable = members.filter((m) => m.id !== ownerId);
  const editing = roles.find((r) => r.id === editingId) ?? null;

  if (editing) {
    return (
      <ModalShell onClose={onClose} labelledBy="kc-roles-title" maxWidthClass="max-w-lg">
        <button type="button" className="kc-role-back" onClick={() => setEditingId(null)}>
          ← All roles
        </button>
        <h2 id="kc-roles-title" className="sr-only">
          Roles & permissions
        </h2>
        <RoleEditor
          key={editing.id}
          role={editing}
          myPermissions={isOwner ? PERM.ADMINISTRATOR | myPermissions : myPermissions}
          onSave={(patch) => saveRole(editing, patch)}
          onCancel={() => setEditingId(null)}
        />
      </ModalShell>
    );
  }

  return (
    <ModalShell onClose={onClose} labelledBy="kc-roles-title" maxWidthClass="max-w-lg">
      <h2
        id="kc-roles-title"
        style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-2xl)", color: "var(--text-primary)" }}
      >
        Roles & permissions
      </h2>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        Hand out exactly the powers you want — nothing more. Higher roles outrank lower ones; drag or use the arrows to
        reorder.
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

      {/* Existing roles, highest first, + assignment */}
      <ol className="kc-role-list mt-5" aria-label="Roles, highest first">
        {ranked.length === 0 ? (
          <li className="text-center text-sm" style={{ color: "var(--text-muted)", padding: "var(--space-4)" }}>
            No roles yet. Create one above to start delegating.
          </li>
        ) : (
          ranked.map((r) => {
            const index = movable.indexOf(r.id);
            const canMove = index >= 0;
            return (
              <li
                key={r.id}
                className={dragId === r.id ? "kc-role-row is-dragging" : "kc-role-row"}
                draggable={canMove}
                onDragStart={(e) => {
                  if (!canMove) return;
                  e.dataTransfer.effectAllowed = "move";
                  setDragId(r.id);
                }}
                onDragOver={(e) => {
                  if (dragId && canMove) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  dropOn(r.id);
                  setDragId(null);
                }}
                onDragEnd={() => setDragId(null)}
              >
                <div className="flex items-center gap-2">
                  {canMove && <span className="kc-role-grip" aria-hidden>⋮⋮</span>}
                  <span className="kc-role-dot" style={{ background: r.color ?? "var(--text-muted)" }} aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sm font-bold" style={{ color: r.color ? paintRoleColor(r.color) : "var(--text-primary)" }}>
                    {r.is_everyone ? "@everyone" : r.name}
                  </span>
                  {canMove && (
                    <>
                      <button
                        type="button"
                        className="kc-role-move"
                        aria-label={`Move ${r.name} up`}
                        disabled={index === 0}
                        onClick={() => void reorder(moveRole(movable, r.id, "up"))}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        className="kc-role-move"
                        aria-label={`Move ${r.name} down`}
                        disabled={index === movable.length - 1}
                        onClick={() => void reorder(moveRole(movable, r.id, "down"))}
                      >
                        ↓
                      </button>
                    </>
                  )}
                  {canEdit(r) && (
                    <button
                      type="button"
                      className="kc-role-edit"
                      aria-label={`Edit ${r.is_everyone ? "@everyone" : r.name}`}
                      onClick={() => setEditingId(r.id)}
                    >
                      Edit
                    </button>
                  )}
                  {!r.is_everyone ? (
                    canEdit(r) && (
                      <button
                        type="button"
                        onClick={() => del(r.id)}
                        className="kc-interactive text-xs font-semibold"
                        style={{ color: "var(--danger)", background: "none", border: "none", cursor: "pointer" }}
                      >
                        Delete role
                      </button>
                    )
                  ) : (
                    <span className="text-[11px] font-bold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>server default</span>
                  )}
                </div>
                <div className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
                  {PERM_LABELS.filter((p) => (r.permissions & p.flag) !== 0).map((p) => p.label).join(" · ") || "No permissions"}
                  {r.hoist ? " · Shown separately" : ""}
                </div>
                {/* assign to members */}
                {!r.is_everyone && canEdit(r) && (
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
                )}
              </li>
            );
          })
        )}
      </ol>
    </ModalShell>
  );
}
