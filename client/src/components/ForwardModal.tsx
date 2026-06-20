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
  const destinations = servers
    .map((server) => ({ server, textChannels: server.channels.filter((c) => c.channel_type === "text") }))
    .filter((item) => item.textChannels.length > 0);

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
        {destinations.length === 0 ? (
          <div className="rounded-2xl px-4 py-5 text-center text-sm" style={{ background: "var(--bg-input)", color: "var(--text-muted)" }}>
            No text channels are available yet. Create a channel first, then forward this message.
          </div>
        ) : destinations.map(({ server: s, textChannels }) => (
            <div key={s.id}>
              <div className="flex items-center gap-2 px-1 text-xs font-bold uppercase" style={{ color: "var(--text-muted)", letterSpacing: "var(--tracking-wide)" }}>
                <span
                  className="flex h-5 w-5 items-center justify-center overflow-hidden rounded-md text-[9px]"
                  style={{ background: "var(--accent)", color: "#fff", letterSpacing: 0 }}
                  aria-hidden
                >
                  {s.icon_url ? <img src={s.icon_url} alt="" className="h-full w-full object-cover" /> : s.name.slice(0, 2).toUpperCase()}
                </span>
                {s.name}
              </div>
              <div className="mt-1 flex flex-col gap-0.5">
                {textChannels.map((c) => (
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
          ))}
      </div>
    </ModalShell>
  );
}
