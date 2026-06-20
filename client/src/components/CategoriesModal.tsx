import { useState } from "react";
import { api, type Category, type Channel } from "../api";
import { ModalShell } from "./ModalShell";

type Props = {
  token: string;
  serverId: string;
  /** Live from the server payload — updates as actions broadcast ServerCreate. */
  categories: Category[];
  channels: Channel[];
  onClose: () => void;
};

/** Create categories and drop channels into them. */
export function CategoriesModal({ token, serverId, categories, channels, onClose }: Props) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.createCategory(token, serverId, name.trim());
      setName("");
    } catch {
      setError("Could not create that category. Try again.");
    } finally {
      setBusy(false);
    }
  }
  const del = (id: string) => api.deleteCategory(token, serverId, id).catch(() => setError("Could not delete that category. Try again."));
  const move = (channelId: string, categoryId: string) =>
    api.moveChannel(token, serverId, channelId, categoryId || null).catch(() => setError("Could not move that channel. Try again."));

  const sorted = [...categories].sort((a, b) => a.position - b.position);
  const textChannels = channels.filter((c) => c.channel_type === "text");

  return (
    <ModalShell onClose={onClose} labelledBy="kc-cats-title" maxWidthClass="max-w-lg">
      <h2
        id="kc-cats-title"
        style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-2xl)", color: "var(--text-primary)" }}
      >
        📁 Categories
      </h2>
      <p className="mt-1 text-sm" style={{ color: "var(--text-secondary)" }}>
        Group channels into collapsible sections.
      </p>

      <form onSubmit={create} className="mt-4 flex gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New category (e.g. Hangout)"
          aria-label="Category name"
          maxLength={48}
          className="kc-field flex-1 px-3.5 py-2.5 text-sm outline-none"
        />
        <button type="submit" disabled={!name.trim() || busy} className="kc-cta flex-shrink-0 px-4 py-2 text-sm" style={{ opacity: !name.trim() || busy ? 0.65 : 1 }}>
          Add
        </button>
      </form>

      {error && (
        <div role="alert" className="mt-3 rounded-xl px-3 py-2 text-sm" style={{ background: "color-mix(in oklch, var(--danger) 12%, var(--bg-elevated))", color: "var(--danger)" }}>
          {error}
        </div>
      )}

      {sorted.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {sorted.map((c) => (
            <span
              key={c.id}
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
              style={{ background: "var(--bg-input)", color: "var(--text-secondary)" }}
            >
              {c.name}
              <button
                type="button"
                onClick={() => del(c.id)}
                aria-label={`Delete ${c.name}`}
                style={{ color: "var(--danger)", background: "none", border: "none", cursor: "pointer" }}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      <h3 className="mt-5 text-xs font-bold uppercase" style={{ color: "var(--text-muted)", letterSpacing: "var(--tracking-wide)" }}>
        Organize channels
      </h3>
      <div className="mt-2 flex flex-col gap-1.5" style={{ maxHeight: 280, overflowY: "auto" }}>
        {textChannels.length === 0 ? (
          <div className="rounded-2xl px-4 py-5 text-center text-sm" style={{ background: "var(--bg-input)", color: "var(--text-muted)" }}>
            No text channels yet. Create one from the sidebar, then organize it here.
          </div>
        ) : textChannels.map((ch) => (
          <div
            key={ch.id}
            className="flex items-center gap-2 px-3 py-2"
            style={{ borderRadius: "var(--radius-md)", background: "var(--bg-input)" }}
          >
            <span className="min-w-0 flex-1 truncate text-sm" style={{ color: "var(--text-primary)" }}># {ch.name}</span>
            <select
              value={ch.category_id ?? ""}
              onChange={(e) => move(ch.id, e.target.value)}
              aria-label={`Category for ${ch.name}`}
              className="kc-field flex-shrink-0 px-2 py-1 text-xs outline-none"
            >
              <option value="">No category</option>
              {sorted.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        ))}
      </div>
    </ModalShell>
  );
}
