// Stub: replaced in the next commit.
import type { Role } from "../api";
export type RolePatch = { name: string; color: string | null; permissions: number; hoist: boolean };
type Props = { role: Role; myPermissions: number; onSave: (patch: RolePatch) => Promise<void>; onCancel: () => void };
export function RoleEditor(_props: Props) {
  return null;
}
