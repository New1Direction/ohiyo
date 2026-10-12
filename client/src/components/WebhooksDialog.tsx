export type WebhookSummary = { id: string; channel_id: string; name: string; avatar_url: string | null; created_at: number };
export type WebhookCreated = WebhookSummary & { token: string; url: string };
export type WebhookApi = {
  list: (channelId: string) => Promise<WebhookSummary[]>;
  create: (channelId: string, name: string) => Promise<WebhookCreated>;
  rename: (id: string, name: string) => Promise<WebhookSummary>;
  renew: (id: string) => Promise<WebhookCreated>;
  remove: (id: string) => Promise<void>;
};

type Props = {
  spaceName: string;
  channels: { id: string; name: string }[];
  webhookApi: WebhookApi;
  urlFor: (webhook: WebhookCreated) => string;
  onCopy: (text: string) => Promise<void>;
  onClose: () => void;
};

/** Not built yet. */
export function WebhooksDialog(_props: Props) {
  return null;
}
