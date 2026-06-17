import { useState } from "react";
import { api, type DiscrawlImportRequest, type DiscrawlImportResponse, type DiscrawlPreview, type ServerWithChannels } from "../api";
import { ModalShell } from "./ModalShell";

type Props = {
  token: string;
  onImported: (server: ServerWithChannels) => void;
  onClose: () => void;
};

export function DiscordImportModal({ token, onImported, onClose }: Props) {
  const [dbPath, setDbPath] = useState("");
  const [mediaRoot, setMediaRoot] = useState("");
  const [guildId, setGuildId] = useState("");
  const [history, setHistory] = useState<"All" | "Last90Days">("All");
  const [preview, setPreview] = useState<DiscrawlPreview | null>(null);
  const [result, setResult] = useState<DiscrawlImportResponse | null>(null);
  const [busy, setBusy] = useState<"preview" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function body(): DiscrawlImportRequest {
    return {
      db_path: dbPath.trim(),
      media_root: mediaRoot.trim() || null,
      guild_id: guildId.trim() || null,
      history,
    };
  }

  async function previewArchive() {
    setBusy("preview");
    setError(null);
    setResult(null);
    try {
      setPreview(await api.previewDiscrawlImport(token, body()));
    } catch (err) {
      setPreview(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function importArchive() {
    setBusy("import");
    setError(null);
    try {
      const result = await api.runDiscrawlImport(token, body());
      setResult(result);
      onImported(result.server);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const disabled = busy !== null || !dbPath.trim() || result !== null;

  return (
    <ModalShell onClose={onClose} labelledBy="discord-import-title" maxWidthClass="max-w-xl">
      <div className="flex flex-col gap-4">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.18em]" style={{ color: "var(--accent)" }}>
            Bring your Discord server
          </div>
          <h2 id="discord-import-title" className="mt-1 text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
            Import a Discrawl archive
          </h2>
          <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
            Phase 2 starts with local/admin Discrawl SQLite imports. The server must enable
            <code> OHIYO_ENABLE_LOCAL_DISCRAWL_IMPORT=1</code>. Imported channels are marked as not E2E.
          </p>
        </div>

        <label className="flex flex-col gap-1 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Discrawl DB path on the server
          <input
            value={dbPath}
            onChange={(e) => setDbPath(e.target.value)}
            placeholder="/data/discrawl/discrawl.db"
            className="kc-field px-3.5 py-3 text-sm outline-none"
          />
        </label>

        <div className="grid gap-3 md:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Media root optional
            <input
              value={mediaRoot}
              onChange={(e) => setMediaRoot(e.target.value)}
              placeholder="/data/discrawl/media"
              className="kc-field px-3.5 py-3 text-sm outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            Guild ID optional
            <input
              value={guildId}
              onChange={(e) => setGuildId(e.target.value)}
              placeholder="auto-select first guild"
              className="kc-field px-3.5 py-3 text-sm outline-none"
            />
          </label>
        </div>

        <label className="flex flex-col gap-1 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          History depth
          <select value={history} onChange={(e) => setHistory(e.target.value as "All" | "Last90Days")} className="kc-field px-3.5 py-3 text-sm outline-none">
            <option value="All">All history</option>
            <option value="Last90Days">Last 90 days</option>
          </select>
        </label>

        {preview && (
          <div className="rounded-2xl border p-4 text-sm" style={{ borderColor: "var(--bg-input)", background: "var(--bg-elevated)", color: "var(--text-primary)" }}>
            <div className="font-bold">{preview.guild_name}</div>
            <div className="mt-2 grid grid-cols-2 gap-2" style={{ color: "var(--text-muted)" }}>
              <span>{preview.categories} categories</span>
              <span>{preview.channels} channels</span>
              <span>{preview.voice_channels} voice rooms</span>
              <span>{preview.threads} threads</span>
              <span>{preview.authors} authors</span>
              <span>{preview.messages} messages</span>
              <span>{preview.downloaded_attachments}/{preview.attachments} attachments downloaded</span>
            </div>
          </div>
        )}

        {result && (
          <div className="rounded-2xl border p-4 text-sm" style={{ borderColor: "var(--accent)", background: "color-mix(in oklch, var(--accent) 10%, var(--bg-elevated))", color: "var(--text-primary)" }}>
            <div className="font-bold">Import complete: {result.server.name}</div>
            <div className="mt-2 grid grid-cols-2 gap-2" style={{ color: "var(--text-muted)" }}>
              <span>{result.report.channels} channels</span>
              <span>{result.report.messages} messages</span>
              <span>{result.report.authors} ghost authors</span>
              <span>{result.report.attachments} attachments</span>
              <span>{result.report.reactions} reactions</span>
              <span>{result.report.roles_needing_review.length} roles need review</span>
            </div>
            <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
              Imported channels are now labeled <strong>not E2E</strong> in the sidebar and chat header.
            </p>
            {result.report.roles_needing_review.length > 0 && (
              <div className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
                Review roles: {result.report.roles_needing_review.join(", ")}
              </div>
            )}
            {result.report.parked.length > 0 && (
              <div className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
                Parked: {result.report.parked.slice(0, 3).join("; ")}{result.report.parked.length > 3 ? "…" : ""}
              </div>
            )}
          </div>
        )}

        {error && <div className="text-sm" style={{ color: "var(--danger, #ef4444)" }}>{error}</div>}

        <div className="flex justify-end gap-2 pt-2">
          {result ? (
            <button type="button" className="kc-interactive px-4 py-2 text-sm font-semibold" style={{ borderRadius: "var(--radius-md)", background: "var(--accent)", color: "#fff" }} onClick={onClose}>Open imported space</button>
          ) : (
            <>
              <button type="button" className="kc-interactive px-4 py-2 text-sm font-semibold" style={{ borderRadius: "var(--radius-md)", background: "var(--bg-input)", color: "var(--text-secondary)" }} onClick={onClose} disabled={busy !== null}>Cancel</button>
              <button type="button" className="kc-interactive px-4 py-2 text-sm font-semibold" style={{ borderRadius: "var(--radius-md)", background: "var(--bg-input)", color: "var(--text-primary)" }} onClick={previewArchive} disabled={disabled}>
                {busy === "preview" ? "Previewing…" : "Preview"}
              </button>
              <button
                type="button"
                className="kc-interactive px-4 py-2 text-sm font-semibold"
                onClick={importArchive}
                disabled={disabled || !preview}
                style={{ borderRadius: "var(--radius-md)", background: "var(--accent)", color: "#fff" }}
              >
                {busy === "import" ? "Importing…" : "Import"}
              </button>
            </>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
