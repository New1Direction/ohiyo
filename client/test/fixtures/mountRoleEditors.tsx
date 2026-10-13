import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { RoleEditor, type RolePatch } from "../../src/components/RoleEditor";
import { ChannelPermissions } from "../../src/components/ChannelPermissions";
import type { Role } from "../../src/api";
import type { OverwriteBits, OverwriteRow } from "../../src/lib/roleColors";
export { act };

export function mountRoleEditor(element: HTMLElement, role: Role, myPermissions: number) {
  const saved: RolePatch[] = [];
  const root = createRoot(element);
  act(() =>
    root.render(
      <RoleEditor
        role={role}
        myPermissions={myPermissions}
        onSave={async (patch) => {
          saved.push(patch);
        }}
        onCancel={() => {}}
      />,
    ),
  );
  return { saved, unmount: () => act(() => root.unmount()) };
}

export function mountChannelPermissions(element: HTMLElement, overwrites: OverwriteRow[], roles: Role[]) {
  const sets: { target_type: string; target_id: string | null; bits: OverwriteBits }[] = [];
  const root = createRoot(element);
  act(() =>
    root.render(
      <ChannelPermissions
        channelName="staff"
        overwrites={overwrites}
        roles={roles}
        members={[]}
        myPermissions={(1 << 11) - 1}
        onSet={async (target_type, target_id, bits) => {
          sets.push({ target_type, target_id, bits });
        }}
        onRemove={async () => {}}
        onSync={async () => {}}
      />,
    ),
  );
  return { sets, unmount: () => act(() => root.unmount()) };
}
