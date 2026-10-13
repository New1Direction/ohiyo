import { useCallback, useEffect, useId, useState } from "react";
import { api, type Channel, type OverwriteScope, type PublicUser, type Role } from "../api";
import { PERM } from "../permissions";
import { errorMessage } from "../lib/errorMessage";
import type { OverwriteBits, OverwriteRow } from "../lib/roleColors";
import { ModalShell } from "./ModalShell";
import { ChannelPermissions } from "./ChannelPermissions";
import "./roles.css";

const CHANNEL_NAME_MAX = 100;
const CHANNEL_TOPIC_MAX = 1024;

type Tab = "overview" | "permissions";

type Props = {
  token: string;
  serverId: string;
  channel: Channel;
  roles: Role[];
  members: PublicUser[];
  /** Your permissions in the space. */
  myPermissions: number;
  onClose: () => void;
};

/** A channel's settings: its name and topic, and who can see and do what in it. */
export function ChannelSettingsModal({ token, serverId, channel, roles, members, myPermissions, onClose }: Props) {
  const titleId = useId();
  const canEditPermissions = (myPermissions & (PERM.MANAGE_ROLES | PERM.ADMINISTRATOR)) !== 0;
  const [tab, setTab] = useState<Tab>("overview");

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    ...(canEditPermissions ? [{ id: "permissions" as const, label: "Permissions" }] : []),
  ];

  return (
    <ModalShell onClose={onClose} labelledBy={titleId} maxWidthClass="max-w-xl">
      <h2 id={titleId} className="kc-role-editor__title">
        #{channel.name} settings
      </h2>
      <div className="kc-channel-tabs" role="tablist" aria-label="Channel settings">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${titleId}-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`${titleId}-${t.id}-panel`}
            className="kc-channel-tab"
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${titleId}-${tab}-panel`} aria-labelledby={`${titleId}-${tab}`}>
        {tab === "overview" ? (
          <ChannelOverview token={token} channel={channel} onSaved={onClose} />
        ) : (
          <ChannelPermissionsTab
            token={token}
            serverId={serverId}
            channel={channel}
            roles={roles}
            members={members}
            myPermissions={myPermissions}
          />
        )}
      </div>
    </ModalShell>
  );
}

function ChannelOverview({ token, channel, onSaved }: { token: string; channel: Channel; onSaved: () => void }) {
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const unchanged = name.trim() === channel.name && topic.trim() === (channel.topic ?? "");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !name.trim() || unchanged) return;
    setBusy(true);
    setError("");
    try {
      await api.updateChannel(token, channel.id, { name: name.trim(), topic: topic.trim() });
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Couldn't save the channel. Try again?"));
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="kc-role-editor">
      <label className="kc-role-editor__field">
        <span className="kc-role-editor__legend">Channel name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Channel name"
          maxLength={CHANNEL_NAME_MAX}
          className="kc-field w-full px-3.5 py-2.5 text-sm outline-none"
        />
      </label>
      <label className="kc-role-editor__field">
        <span className="kc-role-editor__legend">Topic</span>
        <textarea
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          aria-label="Channel topic"
          maxLength={CHANNEL_TOPIC_MAX}
          rows={3}
          placeholder="What's this channel for?"
          className="kc-field w-full px-3.5 py-2.5 text-sm outline-none"
        />
      </label>
      {error && (
        <p role="alert" className="kc-role-editor__note is-error">
          {error}
        </p>
      )}
      <div className="kc-role-editor__actions">
        <button type="submit" disabled={busy || !name.trim() || unchanged} className="kc-cta px-4 py-2 text-sm">
          {busy ? "Saving…" : "Save channel"}
        </button>
      </div>
    </form>
  );
}

type PermissionsTabProps = {
  token: string;
  serverId: string;
  channel: Channel;
  roles: Role[];
  members: PublicUser[];
  myPermissions: number;
};

function ChannelPermissionsTab({ token, serverId, channel, roles, members, myPermissions }: PermissionsTabProps) {
  const scope: OverwriteScope = { type: "channel", id: channel.id };
  const [rows, setRows] = useState<OverwriteRow[] | null>(null);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(async () => {
    try {
      setRows(await api.listOverwrites(token, serverId, { type: "channel", id: channel.id }));
      setLoadError("");
    } catch (err) {
      setLoadError(errorMessage(err, "Couldn't load this channel's permissions."));
    }
  }, [token, serverId, channel.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function after(action: Promise<void>) {
    try {
      await action;
    } catch (err) {
      throw new Error(errorMessage(err, "Couldn't change that. Try again?"));
    } finally {
      await load();
    }
  }

  if (loadError) {
    return (
      <p role="alert" className="kc-role-editor__note is-error">
        {loadError}
      </p>
    );
  }
  if (!rows) return <p className="kc-role-editor__note">Loading…</p>;

  return (
    <ChannelPermissions
      channelName={channel.name}
      overwrites={rows}
      roles={roles}
      members={members}
      myPermissions={myPermissions}
      onSet={(type, id, bits: OverwriteBits) => after(api.setOverwrite(token, serverId, scope, type, id, bits))}
      onRemove={(type, id) => after(api.deleteOverwrite(token, serverId, scope, type, id))}
      onSync={channel.category_id ? () => after(api.clearOverwrites(token, serverId, scope)) : undefined}
    />
  );
}
