import { useId, useState } from "react";
import { ModalShell } from "./ModalShell";
import {
  MUTE_CHOICES,
  describeMute,
  isMuted,
  type NotificationLevel,
  type NotificationSetting,
} from "../lib/notificationSettings";

export type NotificationSettingsTarget = {
  type: "server" | "channel";
  id: string;
  /** The space's name, the channel's name, or the person or group a DM is with. */
  name: string;
  kind: "space" | "channel" | "dm";
};

export type NotificationSettingsSave = { level?: NotificationLevel | null; muted: boolean; mute_seconds?: number | null };

type Props = {
  target: NotificationSettingsTarget;
  setting: NotificationSetting | undefined;
  /** Unix seconds, for "Muted until …". */
  now: number;
  onSave: (body: NotificationSettingsSave) => Promise<void>;
  onClose: () => void;
};

const LEVELS: { value: NotificationLevel; label: string; hint: string }[] = [
  { value: "all", label: "All messages", hint: "Every new message notifies you." },
  { value: "mentions", label: "Only @mentions", hint: "Only messages that mention you, @everyone or @here." },
  { value: "nothing", label: "Nothing", hint: "No notifications from this space, mentions included." },
];

const NOT_MUTED = "off";

/** What a space, channel or DM notifies you about, and muting it, like Discord. */
export function NotificationSettingsDialog({ target, setting, now, onSave, onClose }: Props) {
  const titleId = useId();
  const isSpace = target.kind === "space";
  const [level, setLevel] = useState<NotificationLevel>(setting?.level ?? "all");
  const [muteChoice, setMuteChoice] = useState(NOT_MUTED);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mutedNow = isMuted(setting, now);
  const title =
    target.kind === "space" ? target.name : target.kind === "channel" ? `#${target.name}` : target.name;

  async function save(body: NotificationSettingsSave) {
    setBusy(true);
    setError("");
    try {
      await onSave(isSpace ? { level, ...body } : body);
      onClose();
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : "Couldn't save that. Try again?");
      setBusy(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mutedNow) {
      // Keep the mute as it is: what's left of it, or until it's turned back on.
      const left = setting?.muted_until == null ? null : Math.max(60, setting.muted_until - now);
      void save({ muted: true, mute_seconds: left });
      return;
    }
    const choice = MUTE_CHOICES.find((c) => c.label === muteChoice);
    void save(choice ? { muted: true, mute_seconds: choice.seconds } : { muted: false });
  }

  return (
    <ModalShell onClose={onClose} labelledBy={titleId} maxWidthClass="max-w-md">
      <form onSubmit={submit} className="kc-notif-settings flex flex-col gap-5">
        <div>
          <h2 id={titleId} className="kc-notif-settings__title">
            Notifications for {title}
          </h2>
          <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
            {isSpace
              ? "Choose what this space notifies you about. Your other devices follow too."
              : "Mute it to stop notifications from it. Your other devices follow too."}
          </p>
        </div>

        {isSpace && (
          <fieldset className="flex flex-col gap-1.5" disabled={busy}>
            <legend className="kc-notif-settings__legend">Notify me about</legend>
            {LEVELS.map((option) => (
              <label key={option.value} className={`kc-notif-option${level === option.value ? " is-selected" : ""}`}>
                <input
                  type="radio"
                  name={`${titleId}-level`}
                  value={option.value}
                  checked={level === option.value}
                  onChange={() => setLevel(option.value)}
                />
                <span className="kc-notif-option__name">{option.label}</span>
                <span className="kc-notif-option__hint">{option.hint}</span>
              </label>
            ))}
          </fieldset>
        )}

        <div className="flex flex-col gap-1.5">
          {mutedNow ? (
            <div className="kc-notif-muted" role="status">
              <span className="text-sm" style={{ color: "var(--text-primary)" }}>
                {describeMute(setting, now)}
              </span>
              <button
                type="button"
                disabled={busy}
                className="kc-interactive kc-notif-unmute"
                onClick={() => void save({ muted: false })}
              >
                Unmute
              </button>
            </div>
          ) : (
            <label className="flex flex-col gap-1.5">
              <span className="kc-notif-settings__legend">Mute</span>
              <select
                aria-label="Mute"
                className="kc-field kc-notif-select px-3 py-2.5 text-sm"
                value={muteChoice}
                disabled={busy}
                onChange={(e) => setMuteChoice(e.target.value)}
              >
                <option value={NOT_MUTED}>Don't mute</option>
                {MUTE_CHOICES.map((choice) => (
                  <option key={choice.label} value={choice.label}>
                    {choice.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!isSpace && (
            <p className="text-xs" style={{ color: "var(--text-secondary)" }}>
              {target.kind === "dm"
                ? "A muted chat sends no notifications and doesn't count toward your unread number."
                : "A muted channel stays quiet, but an @mention of you still gets through."}
            </p>
          )}
        </div>

        {error && (
          <div role="alert" className="kc-notif-error text-sm">
            {error}
          </div>
        )}

        <div className="flex gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="kc-interactive kc-notif-cancel">
            Cancel
          </button>
          <button type="submit" disabled={busy} className="kc-cta flex-1 py-3 text-sm">
            Save
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
