import { useState } from "react";
import type { Message, ServerWithChannels } from "../api";
import { ModalShell } from "./ModalShell";

type Props = {
  message: Message;
  servers: ServerWithChannels[];
  onForward: (channelId: string) => void;
  onClose: () => void;
};

/** Pick a destination channel to forward a message to. */
export function ForwardModal({ message, servers, onForward, onClose }: Props) {
  const [busy, setBusy] = useState(false);

  function pick(channelId: string) {
    if (busy) return;
    setBusy(true);
    onForward(channelId);
  }

  const preview = message.content || (message.attachments?.length ? "attachment" : "");

  return (
    <ModalShell onClose={onClose} labelledBy="kc-forward-title" maxWidthClass="max-w-md">
      <h2
        id="kc-forward-title"
        style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-2xl)", color: "var(--text-primary)" }}
      >
        ↪ Forward
      </h2>
      {preview && (
        <div
          className="mt-2 truncate px-3 py-2 text-xs"
          style={{ background: "var(--bg-input)", borderRadius: "var(--radius-md)", color: "var(--text-secondary)" }}
        >
          <strong style={{ color: "var(--text-primary)" }}>{message.author.display_name}:</strong> {preview}
        </div>
      )}

      <div className="mt-4 flex flex-col gap-2" style={{ maxHeight: 360, overflowY: "auto" }}>
        {servers.map((s) => {
          const text = s.channels.filter((c) => c.channel_type === "text");
          if (text.length === 0) return null;
          return (
            <div key={s.id}>
              <div className="px-1 text-xs font-bold uppercase" style={{ color: "var(--text-muted)", letterSpacing: "var(--tracking-wide)" }}>
                {s.name}
              </div>
              <div className="mt-1 flex flex-col gap-0.5">
                {text.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    disabled={busy}
                    onClick={() => pick(c.id)}
                    className="kc-pick-row kc-interactive flex items-center gap-1.5 px-2.5 py-1.5 text-left text-sm"
                    style={{ borderRadius: "var(--radius-md)", color: "var(--text-secondary)" }}
                  >
                    <span style={{ color: "var(--text-muted)" }}>#</span>
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </ModalShell>
  );
}
