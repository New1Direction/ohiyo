// Stub: replaced in the next commit.
import type { PublicUser, Role } from "../api";
import type { OverwriteBits, OverwriteRow } from "../lib/roleColors";
type Props = {
  channelName: string;
  overwrites: OverwriteRow[];
  roles: Role[];
  members: PublicUser[];
  myPermissions: number;
  onSet: (targetType: string, targetId: string | null, bits: OverwriteBits) => Promise<void>;
  onRemove: (targetType: string, targetId: string | null) => Promise<void>;
  onSync?: () => Promise<void>;
};
export function ChannelPermissions(_props: Props) {
  return null;
}
