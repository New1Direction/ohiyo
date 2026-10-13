// Stub (see the change that adds the moderation tools).
export type BanEntry = {
  user: { id: string; username: string; display_name: string; avatar_url: string | null };
  banned_by_name: string | null;
  reason: string | null;
  banned_at: number;
};
export function BansDialog(_props: { api: { list: () => Promise<BanEntry[]>; unban: (userId: string) => Promise<void> }; onClose: () => void }) {
  return null;
}
