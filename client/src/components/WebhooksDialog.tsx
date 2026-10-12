import { useEffect, useId, useRef, useState } from "react";
import { ModalShell } from "./ModalShell";
import { Icon } from "./Icon";

export type WebhookSummary = {
  id: string;
  channel_id: string;
  name: string;
  avatar_url: string | null;
  created_at: number;
  /** Who made it, while their account exists. */
  created_by_name?: string | null;
};
/** A webhook with its secret token, as the server returns it once (made, or URL renewed). */
export type WebhookCreated = WebhookSummary & { token: string; url: string };
export type WebhookApi = {
  list: (channelId: string) => Promise<WebhookSummary[]>;
  create: (channelId: string, name: string) => Promise<WebhookCreated>;
  rename: (id: string, name: string) => Promise<WebhookSummary>;
  renew: (id: string) => Promise<WebhookCreated>;
  remove: (id: string) => Promise<void>;
  /** Upload a picture and set it; left out where uploads aren't possible. */
  setPicture?: (id: string, file: File) => Promise<WebhookSummary>;
};

type Props = {
  spaceName: string;
  /** The space's text channels, in sidebar order. */
  channels: { id: string; name: string }[];
  webhookApi: WebhookApi;
  /** The URL to post to, for a webhook whose token was just issued. */
  urlFor: (webhook: WebhookCreated) => string;
  onCopy: (text: string) => Promise<void>;
  onClose: () => void;
};

/** The same limit as a display name (server: limits::DISPLAY_NAME). */
const NAME_MAX = 64;

function summary({ id, channel_id, name, avatar_url, created_at, created_by_name }: WebhookCreated): WebhookSummary {
  return { id, channel_id, name, avatar_url, created_at, created_by_name };
}

function message(err: unknown, fallback: string): string {
  return err instanceof Error && err.message && err.message.length < 200 ? err.message : fallback;
}

/** A space's incoming webhooks, like Discord's: make one for a channel and copy its URL
 *  (shown once), give it a new URL, rename it, give it a picture, or delete it. */
export function WebhooksDialog({ spaceName, channels, webhookApi, urlFor, onCopy, onClose }: Props) {
  const titleId = useId();
  const [channelId, setChannelId] = useState(channels[0]?.id ?? "");
  const [hooks, setHooks] = useState<WebhookSummary[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The URL on show: only right after it was issued, never again.
  const [shown, setShown] = useState<{ webhook: WebhookCreated; renewed: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const pictureFor = useRef<string | null>(null);
  const pictureInput = useRef<HTMLInputElement>(null);
  const channelName = channels.find((c) => c.id === channelId)?.name ?? "";

  useEffect(() => {
    if (!channelId) return;
    let live = true;
    setHooks(null);
    setLoadError("");
    webhookApi
      .list(channelId)
      .then((list) => {
        if (live) setHooks(list);
      })
      .catch(() => {
        if (live) setLoadError("Couldn't load this channel's webhooks.");
      });
    return () => {
      live = false;
    };
  }, [channelId, webhookApi]);

  async function run(action: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (err) {
      setError(message(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  function show(webhook: WebhookCreated, renewed: boolean) {
    setCopied(false);
    setShown({ webhook, renewed });
  }

  function create(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    void run(async () => {
      const made = await webhookApi.create(channelId, trimmed);
      setHooks((prev) => [...(prev ?? []), summary(made)]);
      setName("");
      show(made, false);
    }, "Couldn't make that webhook. Try again?");
  }

  function renew(hook: WebhookSummary) {
    void run(async () => {
      show(await webhookApi.renew(hook.id), true);
    }, "Couldn't give it a new URL. Try again?");
  }

  function saveName(e: React.FormEvent) {
    e.preventDefault();
    if (!renaming || !renaming.name.trim()) return;
    const { id } = renaming;
    const next = renaming.name.trim();
    void run(async () => {
      const updated = await webhookApi.rename(id, next);
      setHooks((prev) => (prev ?? []).map((h) => (h.id === id ? updated : h)));
      setRenaming(null);
    }, "Couldn't rename it. Try again?");
  }

  function remove(id: string) {
    void run(async () => {
      await webhookApi.remove(id);
      setHooks((prev) => (prev ?? []).filter((h) => h.id !== id));
      setDeleting(null);
      if (shown?.webhook.id === id) setShown(null);
    }, "Couldn't delete it. Try again?");
  }

  function pickPicture(id: string) {
    pictureFor.current = id;
    pictureInput.current?.click();
  }

  function setPicture(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const id = pictureFor.current;
    e.target.value = "";
    if (!file || !id || !webhookApi.setPicture) return;
    const upload = webhookApi.setPicture;
    void run(async () => {
      const updated = await upload(id, file);
      setHooks((prev) => (prev ?? []).map((h) => (h.id === id ? updated : h)));
    }, "Couldn't set that picture. Try an image?");
  }

  async function copy() {
    if (!shown) return;
    try {
      await onCopy(urlFor(shown.webhook));
      setCopied(true);
    } catch {
      setError("Couldn't copy it. Select the URL and copy it yourself.");
    }
  }

  return (
    <ModalShell onClose={onClose} labelledBy={titleId} maxWidthClass="max-w-lg">
      <div className="kc-webhooks flex flex-col gap-4">
        <div>
          <h2 id={titleId} className="kc-webhooks__title">
            Webhooks
          </h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            Let other apps and services post to a channel in {spaceName}. Anyone with a webhook's URL can post as it, so
            keep it secret.
          </p>
        </div>

        {channels.length > 1 && (
          <label className="flex flex-col gap-1.5">
            <span className="kc-webhooks__legend">Channel</span>
            <select
              aria-label="Channel"
              className="kc-field kc-webhooks__select px-3 py-2.5 text-sm"
              value={channelId}
              disabled={busy}
              onChange={(e) => {
                setChannelId(e.target.value);
                setShown(null);
                setRenaming(null);
                setDeleting(null);
              }}
            >
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {shown && (
          <div className="kc-webhooks__secret" role="status">
            <p className="text-sm" style={{ color: "var(--text-primary)" }}>
              <strong>
                {shown.renewed ? `New URL for ${shown.webhook.name}.` : `${shown.webhook.name} is ready.`}
              </strong>{" "}
              {shown.renewed && "The old URL stops working now. "}
              Copy this URL now: you won't see it again.
            </p>
            <div className="flex gap-2">
              <input
                aria-label="Webhook URL"
                readOnly
                value={urlFor(shown.webhook)}
                onFocus={(e) => e.currentTarget.select()}
                className="kc-field kc-webhooks__url min-w-0 flex-1 px-3 py-2 text-xs"
              />
              <button type="button" className="kc-interactive kc-webhooks__button" onClick={() => void copy()}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <button type="button" className="kc-interactive kc-webhooks__button self-start" onClick={() => setShown(null)}>
              Done
            </button>
          </div>
        )}

        <section aria-label={`Webhooks in #${channelName}`} className="flex flex-col gap-2">
          {loadError ? (
            <p role="alert" className="kc-webhooks__error text-sm">
              {loadError}
            </p>
          ) : hooks === null ? (
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
              Loading…
            </p>
          ) : hooks.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
              No webhooks in #{channelName} yet.
            </p>
          ) : (
            <ul className="kc-webhooks__list">
              {hooks.map((hook) => (
                <li key={hook.id} className="kc-webhooks__row">
                  <div className="flex min-w-0 items-center gap-3">
                    <span
                      className="kc-webhooks__avatar"
                      aria-hidden="true"
                      style={hook.avatar_url ? { backgroundImage: `url(${hook.avatar_url})` } : undefined}
                    >
                      {!hook.avatar_url && <Icon name="webhook" size={16} />}
                    </span>
                    {renaming?.id === hook.id ? (
                      <form onSubmit={saveName} className="flex min-w-0 flex-1 flex-wrap gap-2">
                        <input
                          aria-label={`New name for ${hook.name}`}
                          value={renaming.name}
                          maxLength={NAME_MAX}
                          // eslint-disable-next-line jsx-a11y/no-autofocus -- the inline rename field opens on the user's Rename; focusing it is expected
                          autoFocus
                          onChange={(e) => setRenaming({ id: hook.id, name: e.target.value })}
                          className="kc-field min-w-0 flex-1 px-3 py-2 text-sm"
                        />
                        <button type="submit" disabled={busy || !renaming.name.trim()} className="kc-interactive kc-webhooks__button">
                          Save name
                        </button>
                        <button type="button" className="kc-interactive kc-webhooks__button" onClick={() => setRenaming(null)}>
                          Cancel
                        </button>
                      </form>
                    ) : (
                      <span className="flex min-w-0 flex-col">
                        <span className="kc-webhooks__name">{hook.name}</span>
                        {hook.created_by_name && (
                          <span className="kc-webhooks__made-by">Made by {hook.created_by_name}</span>
                        )}
                      </span>
                    )}
                  </div>
                  {renaming?.id !== hook.id && deleting !== hook.id && (
                    <div className="kc-webhooks__actions">
                      <button
                        type="button"
                        disabled={busy}
                        className="kc-interactive kc-webhooks__button"
                        onClick={() => setRenaming({ id: hook.id, name: hook.name })}
                      >
                        Rename
                      </button>
                      {webhookApi.setPicture && (
                        <button type="button" disabled={busy} className="kc-interactive kc-webhooks__button" onClick={() => pickPicture(hook.id)}>
                          Picture
                        </button>
                      )}
                      <button type="button" disabled={busy} className="kc-interactive kc-webhooks__button" onClick={() => renew(hook)}>
                        New URL
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        className="kc-interactive kc-webhooks__button kc-webhooks__button--danger"
                        onClick={() => setDeleting(hook.id)}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                  {deleting === hook.id && (
                    <div className="kc-webhooks__confirm" role="group" aria-label={`Delete ${hook.name}?`}>
                      <p className="text-sm" style={{ color: "var(--text-primary)" }}>
                        Delete {hook.name}? Its URL stops working. Messages it posted stay.
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          disabled={busy}
                          className="kc-interactive kc-webhooks__button kc-webhooks__button--danger-fill"
                          onClick={() => remove(hook.id)}
                        >
                          Delete webhook
                        </button>
                        <button type="button" className="kc-interactive kc-webhooks__button" onClick={() => setDeleting(null)}>
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <form onSubmit={create} className="flex flex-col gap-1.5">
          <label className="kc-webhooks__legend" htmlFor={`${titleId}-name`}>
            New webhook
          </label>
          <div className="flex flex-wrap gap-2">
            <input
              id={`${titleId}-name`}
              aria-label="Webhook name"
              placeholder="Deploy bot"
              value={name}
              maxLength={NAME_MAX}
              disabled={busy || !channelId}
              onChange={(e) => setName(e.target.value)}
              className="kc-field min-w-0 flex-1 px-3 py-2.5 text-sm"
            />
            <button type="submit" disabled={busy || !name.trim() || !channelId} className="kc-cta px-4 py-2.5 text-sm">
              Create webhook
            </button>
          </div>
          <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
            It posts in #{channelName} under its own name, marked APP. Services that send Discord-style webhooks
            ({"{"}"content": "…"{"}"}) work as they are.
          </p>
        </form>

        {error && (
          <div role="alert" className="kc-webhooks__error text-sm">
            {error}
          </div>
        )}

        <input ref={pictureInput} type="file" accept="image/*" hidden onChange={setPicture} />

        <div className="flex justify-end">
          <button type="button" onClick={onClose} className="kc-interactive kc-webhooks__button">
            Close
          </button>
        </div>
      </div>
    </ModalShell>
  );
}
