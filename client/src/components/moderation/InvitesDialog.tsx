// Stub (see the change that adds the moderation tools).
export type InviteRow = {
  code: string;
  created_by: string | null;
  created_by_name: string | null;
  uses: number;
  max_uses: number | null;
  expires_at: number | null;
  created_at: number;
};
export type InviteSettings = { paused: boolean; members_can_invite: boolean };
export function InvitesDialog(_props: {
  api: {
    list: () => Promise<InviteRow[]>;
    revoke: (code: string) => Promise<void>;
    getSettings: () => Promise<InviteSettings | null>;
    updateSettings: (patch: Partial<InviteSettings>) => Promise<InviteSettings>;
  };
  canManageServer: boolean;
  now?: number;
  onClose: () => void;
}) {
  return null;
}
