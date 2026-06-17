import { useEffect, useState } from "react";
import {
  api,
  type DiscrawlImportCapability,
  type DiscrawlImportRequest,
  type DiscrawlImportResponse,
  type DiscrawlPreview,
  type ImportReport,
  type ServerWithChannels,
} from "../api";
import { ModalShell } from "./ModalShell";

type Props = {
  token: string;
  onImported: (server: ServerWithChannels) => void;
  onClose: () => void;
};

const IMPORT_STAGES = [
  "Reading Discrawl archive",
  "Creating your Ohiyo space",
  "Importing channels and history",
  "Re-hosting downloaded attachments",
  "Preparing the report",
];

export function DiscordImportModal({ token, onImported, onClose }: Props) {
  const [capability, setCapability] = useState<DiscrawlImportCapability | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [dbPath, setDbPath] = useState("");
  const [mediaRoot, setMediaRoot] = useState("");
  const [guildId, setGuildId] = useState("");
  const [history, setHistory] = useState<"All" | "Last90Days">("All");
  const [preview, setPreview] = useState<DiscrawlPreview | null>(null);
  const [result, setResult] = useState<DiscrawlImportResponse | null>(null);
  const [uploadedArchive, setUploadedArchive] = useState<{ filename: string; size_bytes: number } | null>(null);
  const [busy, setBusy] = useState<"upload" | "preview" | "import" | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [importStage, setImportStage] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.getDiscrawlImportCapability(token)
      .then((cap) => {
        if (!alive) return;
        setCapability(cap);
        setCapabilityError(null);
      })
      .catch((err) => {
        if (!alive) return;
        setCapability(null);
        setCapabilityError(err instanceof Error ? err.message : String(err));
      });
    return () => { alive = false; };
  }, [token]);

  useEffect(() => {
    if (busy !== "import") return undefined;
    setImportStage(0);
    const timer = window.setInterval(() => {
      setImportStage((stage) => Math.min(stage + 1, IMPORT_STAGES.length - 1));
    }, 700);
    return () => window.clearInterval(timer);
  }, [busy]);

  function body(): DiscrawlImportRequest {
    return {
      db_path: dbPath.trim(),
      media_root: mediaRoot.trim() || null,
      guild_id: guildId.trim() || null,
      history,
    };
  }

  function resetRunState() {
    setPreview(null);
    setResult(null);
    setError(null);
  }

  async function uploadArchive(file: File | undefined) {
    if (!file) return;
    setBusy("upload");
    resetRunState();
    try {
      const uploaded = await api.uploadDiscrawlArchive(token, file);
      const uploadedBody: DiscrawlImportRequest = {
        db_path: uploaded.db_path,
        media_root: mediaRoot.trim() || null,
        guild_id: guildId.trim() || null,
        history,
      };
      setDbPath(uploaded.db_path);
      setUploadedArchive({ filename: uploaded.filename, size_bytes: uploaded.size_bytes });
      setBusy("preview");
      try {
        setPreview(await api.previewDiscrawlImport(token, uploadedBody));
      } catch (err) {
        setPreview(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    } catch (err) {
      setPreview(null);
      setUploadedArchive(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
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
    setImportStage(0);
    try {
      const result = await api.runDiscrawlImport(token, body());
      setImportStage(IMPORT_STAGES.length - 1);
      setResult(result);
      onImported(result.server);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const capabilityLoading = !capability && !capabilityError;
  const importEnabled = capability?.enabled ?? false;
  const canPreview = importEnabled && busy === null && dbPath.trim().length > 0 && result === null;
  const canImport = canPreview && preview !== null;
  const step = result ? 3 : preview ? 2 : 1;

  return (
    <ModalShell onClose={onClose} labelledBy="discord-import-title" maxWidthClass="max-w-2xl">
      <div className="flex flex-col gap-5">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.18em]" style={{ color: "var(--accent)" }}>
            Discord → Ohiyo
          </div>
          <h2 id="discord-import-title" className="mt-1 text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
            Import a server in minutes
          </h2>
          <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
            A fast guided import for Discrawl archives. Ohiyo creates a fresh space, brings over structure and history,
            then clearly marks archive channels as <strong>not E2E</strong> while native Ohiyo chats stay encrypted.
          </p>
        </div>

        <Stepper step={step} />

        {capabilityLoading && (
          <div className="rounded-2xl border p-4 text-sm" style={{ borderColor: "var(--bg-input)", background: "var(--bg-elevated)", color: "var(--text-muted)" }}>
            Checking whether this home can import Discrawl archives…
          </div>
        )}

        {(capabilityError || capability?.enabled === false) && (
          <CapabilityNotice capability={capability} error={capabilityError} />
        )}

        {importEnabled && !result && (
          <div className="rounded-2xl border p-4" style={{ borderColor: "var(--bg-input)", background: "var(--bg-elevated)" }}>
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>1. Choose your archive</div>
                <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
                  Pick your Discrawl SQLite file and Ohiyo uploads it securely. No server paths, no guessing.
                </p>
              </div>
              <span className="rounded-full px-2 py-1 text-[11px] font-bold" style={{ background: "color-mix(in oklch, var(--green) 14%, transparent)", color: "var(--green)" }}>
                Ready
              </span>
            </div>

            <label
              className="kc-interactive mt-4 flex cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed px-4 py-7 text-center"
              onDragEnter={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                void uploadArchive(e.dataTransfer.files?.[0]);
              }}
              style={{
                borderColor: isDragging || uploadedArchive ? "var(--accent)" : "var(--bg-input)",
                background: isDragging ? "color-mix(in oklch, var(--accent) 14%, var(--bg-elevated))" : "color-mix(in oklch, var(--bg-base) 54%, transparent)",
                color: "var(--text-primary)",
              }}
            >
              <input
                type="file"
                accept=".db,.sqlite,.sqlite3,application/vnd.sqlite3,application/x-sqlite3"
                className="sr-only"
                disabled={busy !== null}
                onChange={(e) => {
                  const file = e.currentTarget.files?.[0];
                  e.currentTarget.value = "";
                  void uploadArchive(file);
                }}
              />
              <span className="text-3xl" aria-hidden>📦</span>
              <span className="mt-2 text-base font-bold">
                {busy === "upload" ? "Uploading archive…" : busy === "preview" && uploadedArchive ? "Previewing automatically…" : uploadedArchive ? uploadedArchive.filename : isDragging ? "Drop to upload and preview" : "Drop your Discrawl DB here"}
              </span>
              <span className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
                {uploadedArchive
                  ? `${formatBytes(uploadedArchive.size_bytes)} uploaded${preview ? " — preview ready" : ""}`
                  : "or click to choose a .db, .sqlite, or .sqlite3 file"}
              </span>
            </label>

            <details className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
              <summary className="cursor-pointer font-semibold" style={{ color: "var(--text-secondary)" }}>Advanced options</summary>
              <div className="mt-2 grid gap-3 md:grid-cols-2">
                <label className="flex flex-col gap-1 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                  Server DB path
                  <input
                    value={dbPath}
                    onChange={(e) => { setDbPath(e.target.value); setUploadedArchive(null); resetRunState(); }}
                    placeholder="/data/discrawl/discrawl.db"
                    className="kc-field px-3.5 py-3 text-sm outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                  Guild ID optional
                  <input
                    value={guildId}
                    onChange={(e) => { setGuildId(e.target.value); resetRunState(); }}
                    placeholder="auto-select first guild"
                    className="kc-field px-3.5 py-3 text-sm outline-none"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm font-semibold md:col-span-2" style={{ color: "var(--text-primary)" }}>
                  Media root optional
                  <input
                    value={mediaRoot}
                    onChange={(e) => { setMediaRoot(e.target.value); resetRunState(); }}
                    placeholder="/data/discrawl/media"
                    className="kc-field px-3.5 py-3 text-sm outline-none"
                  />
                </label>
              </div>
            </details>

            <label className="mt-3 flex flex-col gap-1 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              History depth
              <select
                value={history}
                onChange={(e) => { setHistory(e.target.value as "All" | "Last90Days"); resetRunState(); }}
                className="kc-field px-3.5 py-3 text-sm outline-none"
              >
                <option value="All">All history — best for moving in completely</option>
                <option value="Last90Days">Last 90 days — fastest for huge servers</option>
              </select>
            </label>
          </div>
        )}

        {preview && !result && (
          <PreviewCard preview={preview} history={history} />
        )}

        {busy === "import" && <ImportProgress stage={importStage} />}

        {result && <ResultCard result={result} />}

        {error && <div className="text-sm" style={{ color: "var(--danger, #ef4444)" }}>{error}</div>}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {result ? (
            <button type="button" className="kc-interactive px-4 py-2 text-sm font-semibold" style={{ borderRadius: "var(--radius-md)", background: "var(--accent)", color: "#fff" }} onClick={onClose}>Open imported space</button>
          ) : (
            <>
              <button type="button" className="kc-interactive px-4 py-2 text-sm font-semibold" style={{ borderRadius: "var(--radius-md)", background: "var(--bg-input)", color: "var(--text-secondary)" }} onClick={onClose} disabled={busy !== null}>Cancel</button>
              <button type="button" className="kc-interactive px-4 py-2 text-sm font-semibold" style={{ borderRadius: "var(--radius-md)", background: "var(--bg-input)", color: "var(--text-primary)" }} onClick={previewArchive} disabled={!canPreview}>
                {busy === "preview" ? "Previewing…" : preview ? "Refresh preview" : "Preview archive"}
              </button>
              <button
                type="button"
                className="kc-interactive px-4 py-2 text-sm font-semibold"
                onClick={importArchive}
                disabled={!canImport}
                style={{ borderRadius: "var(--radius-md)", background: "var(--accent)", color: "#fff" }}
              >
                {busy === "import" ? IMPORT_STAGES[importStage] : "Import now"}
              </button>
            </>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {["Choose archive", "Preview", "Open space"].map((label, idx) => {
        const n = idx + 1;
        const active = step === n;
        const complete = step > n;
        return (
          <div
            key={label}
            className="flex items-center gap-2 rounded-2xl border px-3 py-2 text-sm font-semibold"
            style={{
              borderColor: active || complete ? "var(--accent)" : "var(--bg-input)",
              background: active ? "color-mix(in oklch, var(--accent) 10%, var(--bg-elevated))" : "var(--bg-elevated)",
              color: active || complete ? "var(--text-primary)" : "var(--text-muted)",
            }}
          >
            <span
              className="flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold"
              style={{ background: complete ? "var(--accent)" : "var(--bg-input)", color: complete ? "#fff" : "var(--text-secondary)" }}
            >
              {complete ? "✓" : n}
            </span>
            {label}
          </div>
        );
      })}
    </div>
  );
}

function CapabilityNotice({ capability, error }: { capability: DiscrawlImportCapability | null; error: string | null }) {
  return (
    <div className="rounded-2xl border p-4 text-sm" style={{ borderColor: "color-mix(in oklch, var(--gold, #f59e0b) 45%, var(--bg-input))", background: "color-mix(in oklch, var(--gold, #f59e0b) 10%, var(--bg-elevated))", color: "var(--text-primary)" }}>
      <div className="font-bold">Import needs to be enabled on this home</div>
      <p className="mt-1" style={{ color: "var(--text-muted)" }}>
        {error ?? capability?.message}
      </p>
      <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
        For now this is an admin/local import flow. The future one-click version will run Discrawl as a managed job after a Discord bot authorization.
      </p>
    </div>
  );
}

function PreviewCard({ preview, history }: { preview: DiscrawlPreview; history: "All" | "Last90Days" }) {
  const isHuge = preview.messages > 100_000 || preview.attachments > 10_000;
  return (
    <div className="rounded-2xl border p-4" style={{ borderColor: "var(--accent)", background: "color-mix(in oklch, var(--accent) 8%, var(--bg-elevated))" }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>2. Preview looks good</div>
          <div className="mt-1 text-xl font-bold" style={{ color: "var(--text-primary)" }}>{preview.guild_name}</div>
          <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
            {history === "All" ? "All history selected." : "Last 90 days selected for a faster first move."} Imported archive channels will be labeled not E2E.
          </p>
        </div>
        {isHuge && (
          <span className="rounded-full px-2 py-1 text-[11px] font-bold" style={{ background: "color-mix(in oklch, var(--gold, #f59e0b) 16%, transparent)", color: "var(--gold, #f59e0b)" }}>
            Large archive
          </span>
        )}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Channels" value={preview.channels} />
        <Stat label="Messages" value={preview.messages} />
        <Stat label="Authors" value={preview.authors} />
        <Stat label="Attachments" value={`${preview.downloaded_attachments}/${preview.attachments}`} />
        <Stat label="Categories" value={preview.categories} />
        <Stat label="Voice" value={preview.voice_channels} />
        <Stat label="Threads" value={preview.threads} />
        <Stat label="Guild ID" value={preview.guild_id} compact />
      </div>
    </div>
  );
}

function ImportProgress({ stage }: { stage: number }) {
  return (
    <div className="rounded-2xl border p-4" style={{ borderColor: "var(--bg-input)", background: "var(--bg-elevated)" }}>
      <div className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>Importing fast…</div>
      <div className="mt-3 flex flex-col gap-2">
        {IMPORT_STAGES.map((label, idx) => {
          const done = idx < stage;
          const active = idx === stage;
          return (
            <div key={label} className="flex items-center gap-2 text-sm" style={{ color: active ? "var(--text-primary)" : "var(--text-muted)", fontWeight: active ? 700 : 500 }}>
              <span className={active ? "kc-pulse" : ""} style={{ width: 9, height: 9, borderRadius: 999, background: done || active ? "var(--accent)" : "var(--bg-input)", display: "inline-block" }} />
              {done ? "✓ " : ""}{label}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ResultCard({ result }: { result: DiscrawlImportResponse }) {
  return (
    <div className="rounded-2xl border p-4 text-sm" style={{ borderColor: "var(--accent)", background: "color-mix(in oklch, var(--accent) 10%, var(--bg-elevated))", color: "var(--text-primary)" }}>
      <div className="text-sm font-bold">3. Import complete</div>
      <div className="mt-1 text-xl font-bold">{result.server.name}</div>
      <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-3">
        <Stat label="Channels" value={result.report.channels} />
        <Stat label="Messages" value={result.report.messages} />
        <Stat label="Ghost authors" value={result.report.authors} />
        <Stat label="Attachments" value={result.report.attachments} />
        <Stat label="Reactions" value={result.report.reactions} />
        <Stat label="Roles to review" value={result.report.roles_needing_review.length} />
      </div>
      <ReportNotes report={result.report} />
      <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
        You are already in the imported space. Close this and start exploring.
      </p>
    </div>
  );
}

function ReportNotes({ report }: { report: ImportReport }) {
  if (report.roles_needing_review.length === 0 && report.parked.length === 0) return null;
  return (
    <div className="mt-3 rounded-xl p-3 text-xs" style={{ background: "color-mix(in oklch, var(--bg-base) 72%, transparent)", color: "var(--text-muted)" }}>
      {report.roles_needing_review.length > 0 && <div><strong>Review roles:</strong> {report.roles_needing_review.join(", ")}</div>}
      {report.parked.length > 0 && <div className="mt-1"><strong>Parked:</strong> {report.parked.slice(0, 3).join("; ")}{report.parked.length > 3 ? "…" : ""}</div>}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function Stat({ label, value, compact = false }: { label: string; value: number | string; compact?: boolean }) {
  return (
    <div className="rounded-xl px-3 py-2" style={{ background: "color-mix(in oklch, var(--bg-base) 72%, transparent)" }}>
      <div className="text-[11px] font-bold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{label}</div>
      <div className={compact ? "truncate text-sm font-bold" : "text-lg font-bold"} style={{ color: "var(--text-primary)" }} title={String(value)}>
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
    </div>
  );
}
