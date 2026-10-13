// Stub (see the change that adds the moderation tools).
export type LogEntry = {
  id: string;
  action: string;
  actor_name: string | null;
  target_name: string | null;
  target_type: string;
  target_id: string;
  reason: string | null;
  metadata: string | null;
  created_at: number;
};
export function ModerationLog(_props: { api: { list: (opts: { action?: string; before?: number }) => Promise<LogEntry[]> }; pageSize?: number }) {
  return null;
}
