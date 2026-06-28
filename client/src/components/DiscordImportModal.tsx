import { useEffect, useRef, useState } from "react";
import {
  api,
  type DiscordConnectInfo,
  type DiscordGuildInfo,
  type DiscrawlImportCapability,
  type DiscrawlImportRequest,
  type DiscrawlImportResponse,
  type DiscrawlPreview,
  type ImportReport,
  type ManagedDiscordImportJob,
  type ServerWithChannels,
} from "../api";
import { ModalShell } from "./ModalShell";

type Props = {
  token: string;
  onImported: (server: ServerWithChannels) => void;
  onClose: () => void;
};

const IMPORT_STAGES = [
  "Reading cloned archive",
  "Creating your Ohiyo space",
  "Importing channels and history",
  "Re-hosting downloaded attachments",
  "Preparing the report",
];

export function DiscordImportModal({ token, onImported, onClose }: Props) {
  const [capability, setCapability] = useState<DiscrawlImportCapability | null>(null);
  const [connectInfo, setConnectInfo] = useState<DiscordConnectInfo | null>(null);
  const [capabilityError, setCapabilityError] = useState<string | null>(null);
  const [templateLink, setTemplateLink] = useState("");
  const [managedGuildId, setManagedGuildId] = useState("");
  const [availableGuilds, setAvailableGuilds] = useState<DiscordGuildInfo[]>([]);
  const [showArchiveFallback, setShowArchiveFallback] = useState(false);
  const [dbPath, setDbPath] = useState("");
  const [mediaRoot, setMediaRoot] = useState("");
  const [guildId, setGuildId] = useState("");
  const [history, setHistory] = useState<"All" | "Last90Days">("All");
  const [preview, setPreview] = useState<DiscrawlPreview | null>(null);
  const [result, setResult] = useState<DiscrawlImportResponse | null>(null);
  const [managedJob, setManagedJob] = useState<ManagedDiscordImportJob | null>(null);
  const [uploadedArchive, setUploadedArchive] = useState<{ filename: string; size_bytes: number } | null>(null);
  const [busy, setBusy] = useState<"guilds" | "upload" | "preview" | "import" | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [importStage, setImportStage] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    api.getDiscrawlImportCapability(token)
      .then(async (cap) => {
        const connect = await api.getDiscordConnectInfo(token).catch(() => null);
        if (!alive) return;
        setCapability(cap);
        setConnectInfo(connect);
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
    setManagedJob(null);
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

  async function refreshDiscordGuilds() {
    setBusy("guilds");
    setError(null);
    try {
      const guilds = await api.listDiscordImportGuilds(token);
      setAvailableGuilds(guilds);
      if (guilds.length === 1) setManagedGuildId(guilds[0].id);
    } catch (err) {
      setAvailableGuilds([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function importTemplate() {
    setBusy("import");
    setError(null);
    setImportStage(0);
    try {
      const imported = await api.runDiscordTemplateImport(token, templateLink.trim());
      setImportStage(IMPORT_STAGES.length - 1);
      setResult(imported);
      onImported(imported.server);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(null);
    }
  }

  async function importManagedDiscord() {
    setBusy("import");
    setError(null);
    setImportStage(0);
    setManagedJob(null);
    try {
      const started = await api.startManagedDiscordImportJob(token, managedGuildId, history);
      if (!mountedRef.current) return;
      setManagedJob(started.job);
      let job = started.job;
      while (mountedRef.current && (job.state === "queued" || job.state === "running")) {
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
        job = await api.getManagedDiscordImportJob(token, started.job.id);
        if (!mountedRef.current) return;
        setManagedJob(job);
      }
      if (job.state === "succeeded" && job.result) {
        setImportStage(IMPORT_STAGES.length - 1);
        setResult(job.result);
        onImported(job.result.server);
      } else if (job.state === "failed") {
        setError(job.error ?? "Discord clone failed");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setBusy(null);
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
  const managedEnabled = capability?.managed_enabled ?? false;
  const canPreview = importEnabled && busy === null && dbPath.trim().length > 0 && result === null;
  const canImport = canPreview && preview !== null;
  const canManagedImport = managedEnabled && busy === null && /^\d{5,}$/.test(managedGuildId.trim()) && result === null;
  const canTemplateImport = busy === null && templateLink.trim().length >= 3 && result === null;
  const showArchiveControls = importEnabled && (!managedEnabled || showArchiveFallback || uploadedArchive !== null || preview !== null);
  const step = result ? 3 : preview || managedGuildId || templateLink.trim() ? 2 : 1;

  return (
    <ModalShell onClose={onClose} labelledBy="discord-import-title" maxWidthClass="max-w-2xl">
      <div className="flex flex-col gap-5">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.18em]" style={{ color: "var(--accent)" }}>
            Discord → Ohiyo
          </div>
          <h2 id="discord-import-title" className="mt-1 text-2xl font-bold" style={{ color: "var(--text-primary)" }}>
            Move your Discord into Ohiyo
          </h2>
          <p className="mt-2 text-sm leading-6" style={{ color: "var(--text-muted)" }}>
            Paste a Discord Server Template link for the one-click move, or use the bot/archive paths when you need message history. Ohiyo rebuilds the familiar shell first, then shows a permission review before you invite people.
          </p>
        </div>

        <Stepper step={step} />

        {capabilityLoading && (
          <div className="rounded-2xl border p-4 text-sm" style={{ borderColor: "var(--bg-input)", background: "var(--bg-elevated)", color: "var(--text-muted)" }}>
            Checking Discord move-in setup…
          </div>
        )}

        {(capabilityError || (capability && !capability.enabled && !capability.managed_enabled)) && (
          <CapabilityNotice capability={capability} error={capabilityError} />
        )}

        {!result && (
          <div className="overflow-hidden rounded-3xl border" style={{ borderColor: "color-mix(in oklch, var(--green, #22c55e) 34%, var(--bg-input))", background: "linear-gradient(145deg, color-mix(in oklch, var(--green, #22c55e) 10%, var(--bg-elevated)), var(--bg-elevated))" }}>
            <div className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-base font-bold" style={{ color: "var(--text-primary)" }}>Import from a Discord template link</div>
                  <p className="mt-1 text-sm leading-6" style={{ color: "var(--text-muted)" }}>
                    Fastest move-in: Ohiyo recreates categories, text/voice channels, roles, role colors, best-effort permissions, server icon, and custom emoji assets when Discord exposes them.
                  </p>
                </div>
                <span className="rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-wide" style={{ background: "var(--green, #22c55e)", color: "#092015" }}>
                  One link
                </span>
              </div>
              <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto]">
                <label className="flex flex-col gap-1 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                  Discord Server Template URL or code
                  <input
                    value={templateLink}
                    onChange={(e) => { setTemplateLink(e.target.value); resetRunState(); }}
                    placeholder="https://discord.new/abc123 or abc123"
                    className="kc-field px-3.5 py-3 text-sm outline-none"
                    autoComplete="off"
                  />
                </label>
                <button
                  type="button"
                  className="kc-interactive self-end px-4 py-3 text-sm font-bold"
                  onClick={importTemplate}
                  disabled={!canTemplateImport}
                  style={{ borderRadius: "var(--radius-md)", background: canTemplateImport ? "var(--green, #22c55e)" : "var(--bg-input)", color: canTemplateImport ? "#092015" : "var(--text-muted)", border: "1px solid var(--bg-hover)", cursor: canTemplateImport ? "pointer" : "not-allowed" }}
                >
                  {busy === "import" && templateLink.trim() ? IMPORT_STAGES[importStage] : "Import template"}
                </button>
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-3">
                <TemplatePromise title="No rebuild" copy="The hierarchy comes over before members arrive." />
                <TemplatePromise title="Role review" copy="Mapped bits and overwrites are called out clearly." />
                <TemplatePromise title="Familiar feel" copy="Icon and emoji assets are pulled in when available." />
              </div>
            </div>
          </div>
        )}

        {managedEnabled && !result && (
          <div className="overflow-hidden rounded-3xl border" style={{ borderColor: "color-mix(in oklch, var(--accent) 28%, var(--bg-input))", background: "linear-gradient(145deg, color-mix(in oklch, var(--accent) 10%, var(--bg-elevated)), var(--bg-elevated))" }}>
            <div className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-base font-bold" style={{ color: "var(--text-primary)" }}>Clone with the Ohiyo bot</div>
                  <p className="mt-1 text-sm leading-6" style={{ color: "var(--text-muted)" }}>
                    The bot can only read enough to copy your server. You choose where to add it, then come back here and pick the server card.
                  </p>
                </div>
                <span className="rounded-full px-3 py-1 text-[11px] font-bold uppercase tracking-wide" style={{ background: "var(--accent)", color: "#fff" }}>
                  Easiest
                </span>
              </div>

              <div className="mt-5 grid gap-3 md:grid-cols-3">
                <a
                  href={connectInfo?.invite_url ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  className="kc-interactive rounded-2xl p-4 text-left text-sm font-semibold"
                  style={{ background: "var(--bg-input)", color: "var(--text-primary)", border: "1px solid var(--bg-hover)", pointerEvents: connectInfo?.invite_url ? "auto" : "none", opacity: connectInfo?.invite_url ? 1 : 0.55, textDecoration: "none" }}
                >
                  <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold" style={{ background: "color-mix(in oklch, var(--accent) 16%, transparent)", color: "var(--accent)" }}>1</span>
                  Add Ohiyo to Discord
                  <span className="mt-1 block text-xs font-medium" style={{ color: "var(--text-muted)" }}>Discord opens in a new window.</span>
                </a>
                <button
                  type="button"
                  className="kc-interactive rounded-2xl p-4 text-left text-sm font-semibold"
                  onClick={refreshDiscordGuilds}
                  disabled={busy !== null}
                  style={{ background: "var(--bg-input)", color: "var(--text-primary)", border: "1px solid var(--bg-hover)", cursor: "pointer" }}
                >
                  <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold" style={{ background: "color-mix(in oklch, var(--accent) 16%, transparent)", color: "var(--accent)" }}>2</span>
                  {busy === "guilds" ? "Looking for servers…" : "Find my servers"}
                  <span className="mt-1 block text-xs font-medium" style={{ color: "var(--text-muted)" }}>We’ll show the ones Ohiyo can see.</span>
                </button>
                <button
                  type="button"
                  className="kc-interactive rounded-2xl p-4 text-left text-sm font-semibold"
                  onClick={importManagedDiscord}
                  disabled={!canManagedImport}
                  style={{ background: canManagedImport ? "var(--accent)" : "var(--bg-input)", color: canManagedImport ? "#fff" : "var(--text-muted)", border: "1px solid var(--bg-hover)", cursor: canManagedImport ? "pointer" : "not-allowed" }}
                >
                  <span className="mb-3 flex h-9 w-9 items-center justify-center rounded-full text-sm font-bold" style={{ background: canManagedImport ? "rgba(255,255,255,.18)" : "color-mix(in oklch, var(--text-primary) 6%, transparent)", color: canManagedImport ? "#fff" : "var(--text-muted)" }}>3</span>
                  {busy === "import" ? (managedJob?.message ?? IMPORT_STAGES[importStage]) : "Clone selected server"}
                  <span className="mt-1 block text-xs font-medium" style={{ color: canManagedImport ? "rgba(255,255,255,.78)" : "var(--text-muted)" }}>Creates your new Ohiyo space.</span>
                </button>
              </div>
            </div>

            {availableGuilds.length > 0 ? (
              <div className="border-t p-5" style={{ borderColor: "color-mix(in oklch, var(--text-primary) 8%, transparent)" }}>
                <div className="mb-3 text-sm font-bold" style={{ color: "var(--text-primary)" }}>Pick the server to move</div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {availableGuilds.map((guild) => {
                    const selected = managedGuildId === guild.id;
                    return (
                      <button
                        key={guild.id}
                        type="button"
                        onClick={() => { setManagedGuildId(guild.id); resetRunState(); }}
                        className="kc-interactive flex items-center gap-3 rounded-2xl border p-3 text-left text-sm"
                        style={{
                          borderColor: selected ? "var(--accent)" : "var(--bg-input)",
                          background: selected ? "color-mix(in oklch, var(--accent) 13%, var(--bg-elevated))" : "var(--bg-input)",
                          color: "var(--text-primary)",
                          boxShadow: selected ? "0 0 0 1px var(--accent), 0 16px 34px -28px var(--accent)" : undefined,
                        }}
                      >
                        <span
                          className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl text-base font-bold"
                          style={{ background: "var(--accent)", color: "#fff", backgroundImage: guild.icon_url ? `url(${guild.icon_url})` : undefined, backgroundSize: "cover", backgroundPosition: "center" }}
                        >
                          {!guild.icon_url && guild.name[0]?.toUpperCase()}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-bold">{guild.name}</span>
                          <span className="block truncate text-xs" style={{ color: "var(--text-muted)" }}>{selected ? "Ready to clone" : "Tap to choose"}</span>
                        </span>
                        {selected && <span className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold" style={{ background: "var(--accent)", color: "white" }} aria-hidden>✓</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="border-t px-5 py-4 text-sm" style={{ borderColor: "color-mix(in oklch, var(--text-primary) 8%, transparent)", color: "var(--text-muted)" }}>
                After adding the bot in Discord, come back and click <strong>Find my servers</strong>. Your server will appear as a card here.
              </div>
            )}

            <details className="mx-5 mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
              <summary className="cursor-pointer font-semibold" style={{ color: "var(--text-secondary)" }}>Server not showing? Advanced help</summary>
              <label className="mt-2 flex flex-col gap-1 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                Discord server ID
                <input
                  value={managedGuildId}
                  onChange={(e) => { setManagedGuildId(e.target.value); resetRunState(); }}
                  placeholder="123456789012345678"
                  inputMode="numeric"
                  className="kc-field px-3.5 py-3 text-sm outline-none"
                />
              </label>
            </details>

            <div className="p-5 pt-4">
              <label className="flex flex-col gap-1 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
                How much history should we bring over?
                <select
                  value={history}
                  onChange={(e) => { setHistory(e.target.value as "All" | "Last90Days"); resetRunState(); }}
                  className="kc-field px-3.5 py-3 text-sm outline-none"
                >
                  <option value="All">Everything — best complete clone</option>
                  <option value="Last90Days">Last 90 days — quickest first move</option>
                </select>
              </label>
              <DiscordCloneChecklist />
            </div>
          </div>
        )}

        {importEnabled && !result && (
          <details open={!managedEnabled || showArchiveFallback} onToggle={(e) => setShowArchiveFallback(e.currentTarget.open)} className="rounded-2xl border p-4" style={{ borderColor: "var(--bg-input)", background: "var(--bg-elevated)" }}>
            <summary className="cursor-pointer text-sm font-bold" style={{ color: "var(--text-primary)" }}>
              Already have an archive file? Advanced import
            </summary>
            <div className="mt-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>Choose your archive</div>
                  <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
                    Drop an Ohiyo-compatible Discord archive file and we’ll upload it securely.
                  </p>
                </div>
                <span className="rounded-full px-2 py-1 text-[11px] font-bold" style={{ background: "color-mix(in oklch, var(--green) 14%, transparent)", color: "var(--green)" }}>
                  Fallback
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
                  {busy === "upload" ? "Uploading archive…" : busy === "preview" && uploadedArchive ? "Previewing automatically…" : uploadedArchive ? uploadedArchive.filename : isDragging ? "Drop to upload and preview" : "Drop your archive file here"}
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
                    Archive path
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
            </div>
          </details>
        )}

        {preview && !result && (
          <PreviewCard preview={preview} history={history} />
        )}

        {busy === "import" && <ImportProgress stage={importStage} job={managedJob} />}

        {result && <ResultCard result={result} />}

        {error && <div className="text-sm" style={{ color: "var(--danger, #ef4444)" }}>{error}</div>}

        <div className="flex flex-wrap justify-end gap-2 pt-1">
          {result ? (
            <button type="button" className="kc-interactive px-4 py-2 text-sm font-semibold" style={{ borderRadius: "var(--radius-md)", background: "var(--accent)", color: "#fff" }} onClick={onClose}>Open imported space</button>
          ) : (
            <>
              <button type="button" className="kc-interactive px-4 py-2 text-sm font-semibold" style={{ borderRadius: "var(--radius-md)", background: "var(--bg-input)", color: "var(--text-secondary)" }} onClick={onClose} disabled={busy !== null}>Cancel</button>
              {showArchiveControls && (
                <>
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
                    {busy === "import" ? IMPORT_STAGES[importStage] : "Import archive"}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

function TemplatePromise({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="rounded-2xl p-3 text-sm" style={{ background: "color-mix(in oklch, var(--bg-base) 58%, transparent)", color: "var(--text-muted)" }}>
      <div className="font-bold" style={{ color: "var(--text-primary)" }}>{title}</div>
      <div className="mt-1 text-xs leading-5">{copy}</div>
    </div>
  );
}

function DiscordCloneChecklist() {
  return (
    <div className="mt-4 rounded-2xl border p-4 text-sm" style={{ borderColor: "var(--bg-input)", background: "color-mix(in oklch, var(--bg-base) 58%, transparent)", color: "var(--text-muted)" }}>
      <div className="font-bold" style={{ color: "var(--text-primary)" }}>Tiny checklist</div>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {[
          ["Open Discord", "Choose the server you want to move."],
          ["Approve Ohiyo", "Click Continue, then Authorize."],
          ["Come back here", "Click Find my servers."],
          ["Clone it", "Pick the card and keep Ohiyo open."],
        ].map(([title, copy], idx) => (
          <div key={title} className="flex gap-2 rounded-xl p-2" style={{ background: "color-mix(in oklch, var(--text-primary) 4%, transparent)" }}>
            <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold" style={{ background: "color-mix(in oklch, var(--accent) 16%, transparent)", color: "var(--accent)" }}>{idx + 1}</span>
            <span>
              <strong style={{ color: "var(--text-primary)" }}>{title}</strong>
              <span className="block text-xs" style={{ color: "var(--text-muted)" }}>{copy}</span>
            </span>
          </div>
        ))}
      </div>
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer font-semibold" style={{ color: "var(--text-secondary)" }}>If your server does not show up</summary>
        <div className="mt-2 space-y-2 leading-5">
          <p>
            Wait a few seconds and click <strong>Find my servers</strong> again. If Discord would not let you add Ohiyo, ask someone with <strong>Manage Server</strong> permission to do the add-bot step.
          </p>
          <p>
            Private channels only copy if the Ohiyo bot role can see them. In Discord, the bot role needs <strong>View Channels</strong> and <strong>Read Message History</strong>.
          </p>
          <p>
            Self-hosting your own bot? Make sure <strong>Server Members Intent</strong> and <strong>Message Content Intent</strong> are enabled in the Discord Developer Portal.
          </p>
        </div>
      </details>
    </div>
  );
}

function Stepper({ step }: { step: number }) {
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {["Choose source", "Review mapping", "Invite safely"].map((label, idx) => {
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
      <div className="font-bold">Bot/archive import is not ready here yet</div>
      <p className="mt-1" style={{ color: "var(--text-muted)" }}>
        {error ?? capability?.message ?? "This Ohiyo home still needs its Discord bot or local archive importer connected by the person hosting it."}
      </p>
      <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
        You can still use a Discord Server Template link above for a fast structure-only move. Use bot/archive import later when you need message history.
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

function ImportProgress({ stage, job }: { stage: number; job: ManagedDiscordImportJob | null }) {
  const liveMessage = job?.message ?? IMPORT_STAGES[stage];
  return (
    <div className="rounded-2xl border p-4" style={{ borderColor: "var(--bg-input)", background: "var(--bg-elevated)" }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-bold" style={{ color: "var(--text-primary)" }}>Cloning in the background…</div>
          <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
            {liveMessage}
          </p>
        </div>
        {job && (
          <span className="rounded-full px-2 py-1 text-[11px] font-bold uppercase tracking-wide" style={{ background: "color-mix(in oklch, var(--accent) 12%, transparent)", color: "var(--accent)" }}>
            {job.state}
          </span>
        )}
      </div>
      <div className="mt-3 flex flex-col gap-2">
        {IMPORT_STAGES.map((label, idx) => {
          const done = idx < stage || job?.state === "succeeded";
          const active = idx === stage && job?.state !== "succeeded";
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
      <div className="text-sm font-bold">3. Import complete — review before inviting</div>
      <div className="mt-1 text-xl font-bold">{result.server.name}</div>
      <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="Channels" value={result.report.channels} />
        <Stat label="Messages" value={result.report.messages} />
        <Stat label="Ghost authors" value={result.report.authors} />
        <Stat label="Emoji assets" value={result.report.emojis ?? 0} />
        <Stat label="Attachments" value={result.report.attachments} />
        <Stat label="Reactions" value={result.report.reactions} />
        <Stat label="Role reviews" value={result.report.roles_needing_review.length} />
        <Stat label="Overwrites" value={result.report.permission_overwrites ?? 0} />
      </div>
      <PermissionReviewCard report={result.report} />
      <ReportNotes report={result.report} />
      <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
        You are already in the imported space. Close this, check roles/channels, then invite people.
      </p>
    </div>
  );
}

function PermissionReviewCard({ report }: { report: ImportReport }) {
  const roles = report.roles_needing_review ?? [];
  const overwrites = report.permission_overwrites ?? 0;
  const clean = roles.length === 0 && overwrites === 0;
  return (
    <div className="mt-4 rounded-2xl border p-4" style={{ borderColor: clean ? "color-mix(in oklch, var(--green, #22c55e) 34%, var(--bg-input))" : "color-mix(in oklch, var(--gold, #f59e0b) 44%, var(--bg-input))", background: "color-mix(in oklch, var(--bg-base) 70%, transparent)" }}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-bold" style={{ color: "var(--text-primary)" }}>{clean ? "Permissions look simple" : "Permission review needed"}</div>
          <p className="mt-1 text-xs leading-5" style={{ color: "var(--text-muted)" }}>
            Ohiyo mapped server-level role permissions where it has equivalents. Discord channel overwrites are preserved for review; do not invite the whole community until sensitive channels look right.
          </p>
        </div>
        <span className="rounded-full px-2 py-1 text-[11px] font-bold uppercase tracking-wide" style={{ background: clean ? "color-mix(in oklch, var(--green, #22c55e) 18%, transparent)" : "color-mix(in oklch, var(--gold, #f59e0b) 18%, transparent)", color: clean ? "var(--green, #22c55e)" : "var(--gold, #f59e0b)" }}>
          {clean ? "low risk" : "check first"}
        </span>
      </div>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        <ReviewStep title="1. Roles" copy={roles.length ? `${roles.slice(0, 3).join(", ")}${roles.length > 3 ? "…" : ""}` : "No flagged role permissions."} />
        <ReviewStep title="2. Private channels" copy={overwrites ? `${overwrites.toLocaleString()} Discord overwrite snapshots preserved.` : "No channel overwrite snapshots."} />
        <ReviewStep title="3. Invite" copy="Invite members only after checking role visibility." />
      </div>
    </div>
  );
}

function ReviewStep({ title, copy }: { title: string; copy: string }) {
  return (
    <div className="rounded-xl p-3" style={{ background: "color-mix(in oklch, var(--text-primary) 4%, transparent)" }}>
      <div className="text-xs font-bold" style={{ color: "var(--text-primary)" }}>{title}</div>
      <div className="mt-1 text-xs leading-5" style={{ color: "var(--text-muted)" }}>{copy}</div>
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
