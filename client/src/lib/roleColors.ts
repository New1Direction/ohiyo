// Stub: replaced by the real rules in the next commit.
type RoleLike = { id: string; name: string; color: string | null; position: number; hoist?: boolean };
type SpaceRoles = { roles?: RoleLike[]; member_roles?: { user_id: string; role_id: string }[] };
export type OverwriteBits = { allow: number; deny: number };
export type OverwriteState = "allow" | "deny" | "inherit";
export type OverwriteRow = OverwriteBits & { target_type: string; target_id: string | null };

export function nameColors(_space: SpaceRoles): Map<string, string> {
  return new Map();
}
export function hoistGroups<M extends { id: string }>(members: M[], _space: SpaceRoles, _online: ReadonlySet<string>) {
  return [{ label: "Members", members }];
}
export function isValidRoleColor(_value: string): boolean {
  return true;
}
export function contrastRatio(_a: string, _b: string): number {
  return 0;
}
export function moveRole(order: string[], _id: string, _dir: "up" | "down"): string[] {
  return order;
}
export function overwriteState(_ow: OverwriteBits, _flag: number): OverwriteState {
  return "inherit";
}
export function withOverwriteState(ow: OverwriteBits, _flag: number, _state: OverwriteState): OverwriteBits {
  return ow;
}
export function isPrivateChannel(_rows: OverwriteRow[]): boolean {
  return false;
}
