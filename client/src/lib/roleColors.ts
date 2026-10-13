// Role colours on names, the member list's role groups, role reordering, and a channel's own
// permissions as allow / inherit / deny. Pure functions, shared by the views that need them.
type RoleLike = { id: string; name: string; color: string | null; position: number; hoist?: boolean; is_everyone?: boolean };
export type SpaceRoles = { roles?: RoleLike[]; member_roles?: { user_id: string; role_id: string }[] };
export type OverwriteBits = { allow: number; deny: number };
export type OverwriteState = "allow" | "deny" | "inherit";
export type OverwriteRow = OverwriteBits & { target_type: string; target_id: string | null };

const VIEW_CHANNEL = 1 << 6;

/** Each holder's roles, highest first. */
function rolesByUser(space: SpaceRoles): Map<string, RoleLike[]> {
  const byId = new Map((space.roles ?? []).map((r) => [r.id, r]));
  const out = new Map<string, RoleLike[]>();
  for (const { user_id, role_id } of space.member_roles ?? []) {
    const role = byId.get(role_id);
    if (!role || role.is_everyone) continue;
    const list = out.get(user_id) ?? [];
    list.push(role);
    out.set(user_id, list);
  }
  for (const list of out.values()) list.sort((a, b) => b.position - a.position);
  return out;
}

/** A name takes the colour of its holder's highest role that has one (as in Discord). */
export function nameColors(space: SpaceRoles): Map<string, string> {
  const colors = new Map<string, string>();
  for (const [userId, roles] of rolesByUser(space)) {
    const colored = roles.find((r) => r.color);
    if (colored?.color) colors.set(userId, colored.color);
  }
  return colors;
}

/** A member's roles in the space, highest first (not @everyone). */
export function memberRolesOf(space: SpaceRoles, userId: string): RoleLike[] {
  return rolesByUser(space).get(userId) ?? [];
}

/** How a role colour is painted: pulled a little toward the theme's text colour, so a dark
 *  colour stays readable on a dark theme and a pale one on a light theme. */
export function paintRoleColor(hex: string): string {
  return `color-mix(in oklch, ${hex} 82%, var(--text-primary))`;
}

/** The member list's sections: each "show separately" role (highest first) with the members
 *  whose highest such role it is, then everyone else as Online and Offline. Empty sections
 *  are left out. */
export function hoistGroups<M extends { id: string }>(
  members: M[],
  space: SpaceRoles,
  online: ReadonlySet<string>,
): { label: string; roleId?: string; members: M[] }[] {
  const byUser = rolesByUser(space);
  const hoisted = (space.roles ?? []).filter((r) => r.hoist && !r.is_everyone).sort((a, b) => b.position - a.position);
  const groups = hoisted.map((r) => ({ label: r.name, roleId: r.id, members: [] as M[] }));
  const onlineGroup = { label: "Online", members: [] as M[] };
  const offlineGroup = { label: "Offline", members: [] as M[] };
  for (const m of members) {
    const top = byUser.get(m.id)?.find((r) => r.hoist);
    const group = top ? groups.find((g) => g.roleId === top.id) : undefined;
    if (group) group.members.push(m);
    else (online.has(m.id) ? onlineGroup : offlineGroup).members.push(m);
  }
  return [...groups, onlineGroup, offlineGroup].filter((g) => g.members.length > 0);
}

export function isValidRoleColor(value: string): boolean {
  return /^#[0-9a-fA-F]{6}$/.test(value);
}

function luminance(hex: string): number {
  const channel = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio between two #rrggbb colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** The order with `id` swapped with its neighbour; unchanged at the ends. */
export function moveRole(order: string[], id: string, dir: "up" | "down"): string[] {
  const i = order.indexOf(id);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= order.length) return order;
  const next = [...order];
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

export function overwriteState(ow: OverwriteBits, flag: number): OverwriteState {
  if (ow.allow & flag) return "allow";
  if (ow.deny & flag) return "deny";
  return "inherit";
}

export function withOverwriteState(ow: OverwriteBits, flag: number, state: OverwriteState): OverwriteBits {
  const allow = ow.allow & ~flag;
  const deny = ow.deny & ~flag;
  if (state === "allow") return { allow: allow | flag, deny };
  if (state === "deny") return { allow, deny: deny | flag };
  return { allow, deny };
}

/** Private: @everyone is denied View channel here. */
export function isPrivateChannel(rows: OverwriteRow[]): boolean {
  return rows.some((r) => r.target_type === "everyone" && (r.deny & VIEW_CHANNEL) !== 0);
}
