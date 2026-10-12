import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  WebhooksDialog,
  type WebhookApi,
  type WebhookCreated,
  type WebhookSummary,
} from "../../src/components/WebhooksDialog";
export { act };

const CHANNELS = [
  { id: "c1", name: "general" },
  { id: "c2", name: "releases" },
];

/** The webhooks dialog for one space, backed by an in-memory list, with every call recorded. */
export function mountWebhooksDialog(element: HTMLElement, initial: WebhookSummary[]) {
  const calls: string[] = [];
  const copied: string[] = [];
  let hooks = [...initial];
  let issued = 0;
  const withToken = (w: WebhookSummary): WebhookCreated => {
    issued += 1;
    return { ...w, token: `secret-${issued}`, url: `https://server.test/api/v1/webhooks/${w.id}/secret-${issued}` };
  };
  const webhookApi: WebhookApi = {
    list: async (channelId) => {
      calls.push(`list ${channelId}`);
      return hooks.filter((h) => h.channel_id === channelId);
    },
    create: async (channelId, name) => {
      calls.push(`create ${channelId} ${name}`);
      const hook = { id: `w${hooks.length + 1}`, channel_id: channelId, name, avatar_url: null, created_at: 1_800_000_000 };
      hooks = [...hooks, hook];
      return withToken(hook);
    },
    rename: async (id, name) => {
      calls.push(`rename ${id} ${name}`);
      hooks = hooks.map((h) => (h.id === id ? { ...h, name } : h));
      return hooks.find((h) => h.id === id)!;
    },
    renew: async (id) => {
      calls.push(`renew ${id}`);
      return withToken(hooks.find((h) => h.id === id)!);
    },
    remove: async (id) => {
      calls.push(`delete ${id}`);
      hooks = hooks.filter((h) => h.id !== id);
    },
  };
  let closed = 0;
  const root = createRoot(element);
  act(() =>
    root.render(
      <WebhooksDialog
        spaceName="Hooks HQ"
        channels={CHANNELS}
        webhookApi={webhookApi}
        urlFor={(w) => `https://ohiyo.test/api/v1/webhooks/${w.id}/${w.token}`}
        fileUrl={(stored) => `https://files.test${stored}`}
        onCopy={async (text) => {
          copied.push(text);
        }}
        onClose={() => {
          closed += 1;
        }}
      />,
    ),
  );
  return { calls, copied, closed: () => closed, unmount: () => act(() => root.unmount()) };
}
