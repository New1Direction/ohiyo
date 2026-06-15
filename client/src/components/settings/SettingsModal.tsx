import { useState, useEffect, useRef } from "react";
import type { PublicUser, ServerEmoji, ServerWithChannels } from "../../api";
import { API_BASE, FILE_BASE, api } from "../../api";
import type { Theme } from "../../themes";
import {
  BUILTIN_THEMES,
  getCustomThemes,
  saveCustomTheme,
  deleteCustomTheme,
  applyTheme,
  exportTheme,
  importTheme,
  loadTheme,
} from "../../themes";
import type { PluginManager } from "../../plugins/registry";
import { isDesktop } from "../../lib/desktop";
import { burnVault } from "../../lib/tauriVault";
import { ACCENT_PRESETS, getActiveAccent, loadAccent, setAccent } from "../../lib/appearance";

type Tab = "account" | "profile" | "appearance" | "plugins" | "social" | "emoji" | "security";

type Props = {
  currentUser: PublicUser | null;
  pluginManager: PluginManager;
  token: string;
  servers: ServerWithChannels[];
  onClose: () => void;
  onToast: (text: string, type?: "info" | "success" | "error") => void;
};

export function SettingsModal({ currentUser, pluginManager, token, servers, onClose, onToast }: Props) {
  const [tab, setTab] = useState<Tab>("appearance");

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- dismiss scrim; Escape handled via onKeyDown, container focusable via tabIndex
    <div
      className="fixed inset-0 z-50 flex items-stretch"
      style={{ background: "rgba(0,0,0,0.7)" }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
      onKeyDown={handleKey}
      tabIndex={-1}
    >
      <div
        className="flex h-full w-full overflow-hidden"
        style={{ background: "var(--bg-channel)" }}
      >
        {/* Settings sidebar */}
        <div
          className="flex w-60 flex-shrink-0 flex-col overflow-y-auto py-16 pl-8 pr-4"
          style={{ background: "var(--bg-sidebar)" }}
        >
          <div className="mb-4 text-xs font-bold uppercase" style={{ color: "var(--text-muted)" }}>
            User Settings
          </div>
          {(["account", "profile", "social", "security", "appearance", "plugins", "emoji"] as Tab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="mb-0.5 rounded px-3 py-1.5 text-left text-sm font-medium capitalize"
              style={{
                background: tab === t ? "var(--bg-hover)" : "transparent",
                color: tab === t ? "var(--text-primary)" : "var(--text-secondary)",
              }}
            >
              {t === "social"
                ? "Social Links"
                : t === "plugins"
                  ? "Plugins"
                  : t === "emoji"
                    ? "Custom Emoji"
                    : t === "security"
                      ? "Privacy & Security"
                      : t}
            </button>
          ))}

          <div className="mt-4 border-t pt-4" style={{ borderColor: "var(--bg-hover)" }}>
            <button
              onClick={onClose}
              className="rounded px-3 py-1.5 text-left text-sm"
              style={{ color: "var(--danger)", width: "100%" }}
            >
              ✕  Close Settings
            </button>
          </div>
        </div>

        {/* Settings content */}
        <div className="flex-1 overflow-y-auto px-10 py-16">
          {tab === "appearance" && <AppearanceTab onToast={onToast} />}
          {tab === "plugins" && <PluginsTab pluginManager={pluginManager} onToast={onToast} />}
          {tab === "account" && <AccountTab currentUser={currentUser} token={token} onToast={onToast} />}
          {tab === "profile" && <ProfileTab token={token} onToast={onToast} />}
          {tab === "social" && <SocialTab token={token} onToast={onToast} />}
          {tab === "security" && <SecurityTab token={token} onToast={onToast} />}
          {tab === "emoji" && <EmojiTab token={token} servers={servers} onToast={onToast} />}
        </div>
      </div>
    </div>
  );
}

// ── Appearance tab ────────────────────────────────────────────────────────────

function AppearanceTab({ onToast }: { onToast: (t: string, type?: "info" | "success" | "error") => void }) {
  const [currentTheme, setCurrentTheme] = useState<Theme>(loadTheme);
  const [customThemes, setCustomThemes] = useState<Theme[]>(getCustomThemes);
  const [importText, setImportText] = useState("");
  const [accent, setAccentVal] = useState<string>(getActiveAccent);
  const [accentOverride, setAccentOverride] = useState<boolean>(() => loadAccent() !== null);

  const allThemes = [...BUILTIN_THEMES, ...customThemes];

  function select(theme: Theme) {
    applyTheme(theme);
    setCurrentTheme(theme);
    // Keep a personal accent layered over the new theme; otherwise follow the theme.
    const ov = loadAccent();
    if (ov) setAccent(ov);
    setAccentVal(ov ?? theme.vars["--accent"]);
    onToast(`Theme "${theme.name}" applied`, "success");
  }

  function chooseAccent(hex: string) {
    setAccent(hex);
    setAccentVal(hex);
    setAccentOverride(true);
  }

  function resetAccent() {
    setAccent(null);
    setAccentVal(currentTheme.vars["--accent"]);
    setAccentOverride(false);
    onToast("Accent reset to theme default", "success");
  }

  function handleExport(theme: Theme) {
    const json = exportTheme(theme);
    navigator.clipboard.writeText(json).then(() => onToast("Theme copied to clipboard", "success"));
  }

  function handleImport() {
    try {
      const theme = importTheme(importText);
      saveCustomTheme(theme);
      setCustomThemes(getCustomThemes());
      select(theme);
      setImportText("");
    } catch {
      onToast("Invalid theme JSON", "error");
    }
  }

  function handleDeleteCustom(id: string) {
    deleteCustomTheme(id);
    setCustomThemes(getCustomThemes());
    if (currentTheme.id === id) select(BUILTIN_THEMES[0]);
  }

  return (
    <div>
      <h2 className="mb-1 text-xl font-bold">Appearance</h2>
      <p className="mb-6 text-sm" style={{ color: "var(--text-muted)" }}>
        Make it yours — pick an accent, choose a theme, or build your own.
      </p>

      {/* Accent color — recolors the whole app, layered over any theme. Free here;
          Discord charges for it. */}
      <div className="mb-8">
        <div className="mb-1 text-sm font-semibold">Accent color</div>
        <p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
          The color that runs through everything — buttons, links, highlights, focus rings.
          Works on top of any theme.
        </p>
        <div className="flex flex-wrap items-center gap-2.5">
          {ACCENT_PRESETS.map((p) => {
            const isActive = accent.toLowerCase() === p.hex.toLowerCase();
            return (
              <button
                key={p.hex}
                type="button"
                title={p.name}
                aria-label={`Accent ${p.name}`}
                aria-pressed={isActive}
                onClick={() => chooseAccent(p.hex)}
                className="kc-accent-swatch"
                style={{
                  background: p.hex,
                  boxShadow: isActive ? `0 0 0 2px var(--bg-channel), 0 0 0 4px ${p.hex}` : undefined,
                }}
              >
                {isActive && (
                  <span aria-hidden="true" style={{ color: "#fff", fontSize: 12, fontWeight: 700 }}>
                    ✓
                  </span>
                )}
              </button>
            );
          })}

          {/* Custom color — native picker behind a rainbow swatch */}
          <label
            className="kc-accent-swatch kc-accent-custom"
            title="Custom color"
            style={{
              background:
                "conic-gradient(from 180deg, #f2683c, #e0992f, #1f9e6b, #1f9e9e, #3da5f2, #7c6dfa, #eb6f92, #f2683c)",
            }}
          >
            <input
              type="color"
              value={accent}
              onChange={(e) => chooseAccent(e.target.value)}
              aria-label="Pick a custom accent color"
              style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }}
            />
            <span
              aria-hidden="true"
              style={{ color: "#fff", fontSize: 14, fontWeight: 700, textShadow: "0 1px 2px rgba(0,0,0,.45)" }}
            >
              +
            </span>
          </label>

          {accentOverride && (
            <button
              type="button"
              onClick={resetAccent}
              className="kc-interactive ml-1 rounded px-2 py-1 text-xs"
              style={{ color: "var(--text-secondary)", background: "transparent", border: "1px solid var(--bg-hover)" }}
            >
              Reset to theme
            </button>
          )}
        </div>
      </div>

      <div className="mb-1 text-sm font-semibold">Theme</div>
      <div className="grid grid-cols-3 gap-3 mb-8 mt-2">
        {allThemes.map((theme) => {
          const isSelected = currentTheme.id === theme.id;
          const isCustom = !BUILTIN_THEMES.find((b) => b.id === theme.id);
          return (
            <div
              key={theme.id}
              role="button"
              tabIndex={0}
              onClick={() => select(theme)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(theme); }
              }}
              className="relative cursor-pointer rounded-lg overflow-hidden"
              style={{
                border: `2px solid ${isSelected ? "var(--accent)" : "var(--bg-hover)"}`,
                transition: "border-color 0.15s",
              }}
            >
              {/* Color preview */}
              <div className="h-14" style={{ background: theme.vars["--bg-sidebar"] }}>
                <div className="h-4" style={{ background: theme.vars["--bg-base"] }} />
                <div className="flex gap-1 px-2 py-1">
                  {["--accent", "--green", "--danger"].map((v) => (
                    <div
                      key={v}
                      className="h-2 w-2 rounded-full"
                      style={{ background: theme.vars[v as keyof typeof theme.vars] }}
                    />
                  ))}
                </div>
              </div>
              <div
                className="flex items-center justify-between px-2 py-1.5"
                style={{ background: theme.vars["--bg-channel"] }}
              >
                <span className="text-xs font-semibold" style={{ color: theme.vars["--text-primary"] }}>
                  {theme.name}
                </span>
                {isCustom && (
                  <button
                    onClick={(e) => { e.stopPropagation(); handleDeleteCustom(theme.id); }}
                    className="text-xs"
                    style={{ color: theme.vars["--danger"] }}
                  >
                    ✕
                  </button>
                )}
              </div>
              {isSelected && (
                <div
                  className="absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full text-xs"
                  style={{ background: "var(--accent)", color: "white" }}
                >
                  ✓
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Export / Import */}
      <div className="rounded-lg p-4" style={{ background: "var(--bg-sidebar)" }}>
        <div className="mb-2 font-semibold text-sm">Import / Export Theme</div>
        <button
          onClick={() => handleExport(currentTheme)}
          className="mb-3 rounded px-3 py-1.5 text-sm"
          style={{ background: "var(--accent)", color: "white" }}
        >
          Export Current Theme
        </button>
        <textarea
          placeholder="Paste theme JSON here…"
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          rows={4}
          className="mb-2 w-full rounded p-2 text-xs outline-none font-mono"
          style={{ background: "var(--bg-input)", color: "var(--text-primary)", resize: "vertical" }}
        />
        <button
          onClick={handleImport}
          disabled={!importText.trim()}
          className="rounded px-3 py-1.5 text-sm"
          style={{ background: importText.trim() ? "var(--accent)" : "var(--bg-hover)", color: "white" }}
        >
          Import Theme
        </button>
      </div>
    </div>
  );
}

// ── Plugins tab ───────────────────────────────────────────────────────────────

function PluginsTab({
  pluginManager,
  onToast,
}: {
  pluginManager: PluginManager;
  onToast: (t: string, type?: "info" | "success" | "error") => void;
}) {
  const [enabled, setEnabled] = useState<string[]>(() => pluginManager.enabledIds());
  const [plugins, setPlugins] = useState(() => pluginManager.allPlugins());
  const [urlInput, setUrlInput] = useState("");
  const [installing, setInstalling] = useState(false);

  function toggle(id: string) {
    if (enabled.includes(id)) {
      pluginManager.disable(id);
      setEnabled(pluginManager.enabledIds());
      onToast(`Plugin disabled`, "info");
    } else {
      pluginManager.enable(id);
      setEnabled(pluginManager.enabledIds());
      onToast(`Plugin enabled`, "success");
    }
  }

  async function installFromUrl() {
    const url = urlInput.trim();
    if (!url) return;
    setInstalling(true);
    try {
      const id = await pluginManager.installFromUrl(url);
      setPlugins(pluginManager.allPlugins());
      pluginManager.enable(id);
      setEnabled(pluginManager.enabledIds());
      setUrlInput("");
      onToast(`Plugin installed!`, "success");
    } catch (err) {
      onToast(`Install failed: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setInstalling(false);
    }
  }

  function uninstall(id: string) {
    pluginManager.uninstallUserPlugin(id);
    setPlugins(pluginManager.allPlugins());
    setEnabled(pluginManager.enabledIds());
    onToast("Plugin removed", "info");
  }

  const builtinPlugins = plugins.filter((p) => !pluginManager.isUserPlugin(p.id));
  const userPlugins = plugins.filter((p) => pluginManager.isUserPlugin(p.id));

  function PluginRow({ plugin, showUninstall }: { plugin: { id: string; name: string; version: string; author?: string; description: string }; showUninstall?: boolean }) {
    const isOn = enabled.includes(plugin.id);
    return (
      <div
        className="flex items-center gap-4 rounded-lg p-4"
        style={{ background: "var(--bg-sidebar)" }}
      >
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>
            {plugin.name}
            <span className="ml-2 text-xs font-normal" style={{ color: "var(--text-muted)" }}>
              v{plugin.version}
            </span>
            {plugin.author && (
              <span className="ml-1 text-xs font-normal" style={{ color: "var(--text-muted)" }}>
                · {plugin.author}
              </span>
            )}
          </div>
          <div className="text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>
            {plugin.description}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {showUninstall && (
            <button
              onClick={() => uninstall(plugin.id)}
              className="text-xs px-2 py-1 rounded"
              style={{ background: "var(--bg-hover)", color: "var(--danger)" }}
            >
              Remove
            </button>
          )}
          <button
            onClick={() => toggle(plugin.id)}
            className="relative h-6 w-12 rounded-full transition-colors duration-150"
            style={{ background: isOn ? "var(--accent)" : "var(--bg-hover)" }}
          >
            <span
              className="absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-150"
              style={{ transform: isOn ? "translateX(26px)" : "translateX(2px)" }}
            />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="mb-1 text-xl font-bold">Plugins</h2>
      <p className="mb-6 text-sm" style={{ color: "var(--text-muted)" }}>
        Toggle plugins or install from URL. All plugins run locally — no data leaves your device.
      </p>

      {/* Install from URL */}
      <div className="mb-6 rounded-lg p-4" style={{ background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)" }}>
        <div className="mb-2 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Install Plugin from URL
        </div>
        <p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
          Paste a URL to a JavaScript ES module that exports a default KikkacordPlugin object.
        </p>
        <div className="flex gap-2">
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://example.com/my-plugin.js"
            className="flex-1 rounded px-3 py-2 text-sm outline-none font-mono"
            style={{ background: "var(--bg-input)", color: "var(--text-primary)" }}
            onKeyDown={(e) => { if (e.key === "Enter") installFromUrl(); }}
          />
          <button
            onClick={installFromUrl}
            disabled={installing || !urlInput.trim()}
            className="rounded px-3 py-2 text-sm font-semibold"
            style={{ background: urlInput.trim() && !installing ? "var(--accent)" : "var(--bg-hover)", color: "white" }}
          >
            {installing ? "…" : "Install"}
          </button>
        </div>
      </div>

      {/* User-installed plugins */}
      {userPlugins.length > 0 && (
        <div className="mb-4">
          <div className="mb-2 text-xs font-bold uppercase" style={{ color: "var(--text-muted)" }}>
            User Installed ({userPlugins.length})
          </div>
          <div className="flex flex-col gap-2">
            {userPlugins.map((p) => <PluginRow key={p.id} plugin={p} showUninstall />)}
          </div>
        </div>
      )}

      {/* Built-in plugins */}
      <div>
        <div className="mb-2 text-xs font-bold uppercase" style={{ color: "var(--text-muted)" }}>
          Built-in ({builtinPlugins.length})
        </div>
        <div className="flex flex-col gap-2">
          {builtinPlugins.map((p) => <PluginRow key={p.id} plugin={p} />)}
        </div>
      </div>
    </div>
  );
}

// ── Account tab ───────────────────────────────────────────────────────────────

function AccountTab({ currentUser, token, onToast }: { currentUser: PublicUser | null; token: string; onToast: (t: string, type?: "info" | "success" | "error") => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(currentUser?.avatar_url ?? null);

  if (!currentUser) return null;

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch(`${API_BASE}/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const data = await res.json() as Array<{ id: string; url: string }>;
      const fileId = data[0]?.id;
      if (!fileId) throw new Error("Upload failed");
      await api.setAvatar(token, fileId);
      setAvatarUrl(`${FILE_BASE}/files/${fileId}`);
      onToast("Avatar updated! GIFs are supported.", "success");
    } catch (err) {
      onToast(`Avatar upload failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  return (
    <div>
      <h2 className="mb-6 text-xl font-bold">My Account</h2>
      <div className="rounded-lg p-6" style={{ background: "var(--bg-sidebar)" }}>
        <div className="flex items-center gap-4">
          <div className="relative">
            {avatarUrl ? (
              <img src={avatarUrl} alt="avatar" className="h-16 w-16 rounded-full object-cover" />
            ) : (
              <div
                className="flex h-16 w-16 items-center justify-center rounded-full text-2xl font-bold"
                style={{ background: "var(--accent)", color: "#fff" }}
              >
                {currentUser.display_name[0]?.toUpperCase()}
              </div>
            )}
            <button
              onClick={() => fileRef.current?.click()}
              className="absolute inset-0 flex items-center justify-center rounded-full text-xs font-semibold opacity-0 hover:opacity-100 transition-opacity"
              style={{ background: "rgba(0,0,0,0.6)", color: "#fff" }}
            >
              Change
            </button>
          </div>
          <div>
            <div className="text-lg font-bold">{currentUser.display_name}</div>
            <div className="text-sm" style={{ color: "var(--text-muted)" }}>@{currentUser.username}</div>
            <div className="text-xs mt-1 font-mono" style={{ color: "var(--text-muted)" }}>ID: {currentUser.id}</div>
            <button
              onClick={() => fileRef.current?.click()}
              className="mt-2 rounded px-3 py-1 text-xs font-semibold"
              style={{ background: "var(--accent)", color: "#fff" }}
            >
              Upload Avatar / Animated GIF
            </button>
          </div>
        </div>
        <input ref={fileRef} type="file" accept="image/*,.gif" className="hidden" onChange={handleAvatarUpload} />
        <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
          Supports PNG, JPG, WebP, and animated GIF. Unlike Discord, GIF avatars are free for all users.
        </p>
      </div>
    </div>
  );
}

// ── Custom Emoji tab ──────────────────────────────────────────────────────────

function EmojiTab({ token, servers, onToast }: { token: string; servers: ServerWithChannels[]; onToast: (t: string, type?: "info" | "success" | "error") => void }) {
  const [selectedServerId, setSelectedServerId] = useState<string>(servers[0]?.id ?? "");
  const [emojis, setEmojis] = useState<ServerEmoji[]>([]);
  const [newName, setNewName] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!selectedServerId) return;
    api.listEmojis(token, selectedServerId).then(setEmojis).catch((e) => console.warn("[kikkacord] couldn't load emoji", e));
  }, [token, selectedServerId]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !newName.trim() || !selectedServerId) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`${API_BASE}/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const data = await res.json() as Array<{ id: string }>;
      const fileId = data[0]?.id;
      if (!fileId) throw new Error("Upload failed");
      const emoji = await api.createEmoji(token, selectedServerId, newName.trim(), fileId);
      setEmojis((prev) => [...prev, emoji]);
      setNewName("");
      onToast(`Emoji :${emoji.name}: added!`, "success");
    } catch (err) {
      onToast(`Failed: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleDelete(emojiId: string, name: string) {
    try {
      await api.deleteEmoji(token, selectedServerId, emojiId);
      setEmojis((prev) => prev.filter((e) => e.id !== emojiId));
      onToast(`Removed :${name}:`, "info");
    } catch (err) {
      onToast(`Failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  return (
    <div>
      <h2 className="mb-1 text-xl font-bold">Custom Emoji</h2>
      <p className="mb-4 text-sm" style={{ color: "var(--text-muted)" }}>
        Upload custom emoji for any server. Use them in messages with <code>:name:</code> syntax. GIF emoji are supported for all users — no Nitro required.
      </p>

      {servers.length === 0 ? (
        <p style={{ color: "var(--text-muted)" }}>You're not in any servers yet.</p>
      ) : (
        <>
          {/* Server selector */}
          <div className="mb-4">
            <label htmlFor="kc-emoji-server-select" className="mb-1.5 block text-xs font-bold uppercase" style={{ color: "var(--text-muted)" }}>Server</label>
            <select
              id="kc-emoji-server-select"
              value={selectedServerId}
              onChange={(e) => setSelectedServerId(e.target.value)}
              className="rounded px-3 py-2 text-sm outline-none"
              style={{ background: "var(--bg-input)", color: "var(--text-primary)", border: "1px solid var(--bg-hover)" }}
            >
              {servers.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>

          {/* Upload new emoji */}
          <div className="mb-6 rounded-lg p-4" style={{ background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)" }}>
            <div className="mb-2 text-sm font-semibold">Add New Emoji</div>
            <div className="flex gap-2 items-center">
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))}
                placeholder="emoji_name"
                className="w-36 rounded px-3 py-2 text-sm outline-none font-mono"
                style={{ background: "var(--bg-input)", color: "var(--text-primary)" }}
              />
              <button
                onClick={() => fileRef.current?.click()}
                disabled={!newName.trim() || uploading}
                className="rounded px-3 py-2 text-sm font-semibold"
                style={{ background: newName.trim() && !uploading ? "var(--accent)" : "var(--bg-hover)", color: "#fff" }}
              >
                {uploading ? "Uploading…" : "Choose Image / GIF"}
              </button>
              <input ref={fileRef} type="file" accept="image/*,.gif" className="hidden" onChange={handleUpload} />
            </div>
            <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>Name: letters, numbers, underscores only (2–32 chars). GIF for animated emoji!</p>
          </div>

          {/* Emoji list */}
          {emojis.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>No custom emoji yet. Upload one above!</p>
          ) : (
            <div className="flex flex-col gap-2">
              {emojis.map((e) => (
                <div key={e.id} className="flex items-center gap-3 rounded-lg px-4 py-3" style={{ background: "var(--bg-sidebar)" }}>
                  <img src={`${FILE_BASE}${e.url}`} alt={`:${e.name}:`} className="h-8 w-8 rounded object-contain" style={{ imageRendering: "pixelated" }} />
                  <div className="flex-1">
                    <span className="font-mono text-sm" style={{ color: "var(--text-primary)" }}>:{e.name}:</span>
                  </div>
                  <button
                    onClick={() => handleDelete(e.id, e.name)}
                    className="text-xs px-2 py-1 rounded"
                    style={{ background: "var(--bg-hover)", color: "var(--danger)" }}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ── Profile tab ───────────────────────────────────────────────────────────────

function ProfileTab({ token, onToast }: { token: string; onToast: (t: string, type?: "info" | "success" | "error") => void }) {
  const [bio, setBio] = useState("");
  const [pronouns, setPronouns] = useState("");
  const [status, setStatus] = useState("");
  const [bannerColor, setBannerColor] = useState("#5865f2");

  useEffect(() => {
    fetch(`${API_BASE}/users/@me/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((d) => {
        setBio(d.bio ?? "");
        setPronouns(d.pronouns ?? "");
        setStatus(d.custom_status ?? "");
        setBannerColor(d.banner_color ?? "#f2683c");
      })
      .catch((e) => console.warn("[kikkacord] couldn't load profile", e));
  }, [token]);

  async function save() {
    try {
      await fetch(`${API_BASE}/users/@me/profile`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ bio, pronouns, banner_color: bannerColor, custom_status: status }),
      });
      onToast("Profile saved", "success");
    } catch {
      onToast("Failed to save", "error");
    }
  }

  return (
    <div>
      <h2 className="mb-6 text-xl font-bold">Profile</h2>
      <Field label="Custom Status" hint="Shown below your username">
        <input
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          placeholder="Building something cool..."
          className="w-full rounded px-3 py-2 text-sm outline-none"
          style={{ background: "var(--bg-input)", color: "var(--text-primary)" }}
        />
      </Field>
      <Field label="Pronouns">
        <input
          value={pronouns}
          onChange={(e) => setPronouns(e.target.value)}
          placeholder="they/them"
          className="w-full rounded px-3 py-2 text-sm outline-none"
          style={{ background: "var(--bg-input)", color: "var(--text-primary)" }}
        />
      </Field>
      <Field label="Bio">
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          placeholder="Tell people about yourself..."
          rows={4}
          className="w-full rounded px-3 py-2 text-sm outline-none resize-none"
          style={{ background: "var(--bg-input)", color: "var(--text-primary)" }}
        />
      </Field>
      <Field label="Banner Color">
        <div className="flex items-center gap-3">
          <input type="color" value={bannerColor} onChange={(e) => setBannerColor(e.target.value)} />
          <span className="text-sm font-mono" style={{ color: "var(--text-secondary)" }}>{bannerColor}</span>
        </div>
      </Field>
      <button
        onClick={save}
        className="mt-2 rounded px-4 py-2 text-sm font-semibold text-white"
        style={{ background: "var(--accent)" }}
      >
        Save Profile
      </button>
    </div>
  );
}

// ── Social tab ────────────────────────────────────────────────────────────────

const SOCIALS = [
  { key: "social_spotify", label: "Spotify", icon: "🎵", placeholder: "spotify:artist:..." },
  { key: "social_github", label: "GitHub", icon: "🐙", placeholder: "github-username" },
  { key: "social_twitter", label: "Twitter / X", icon: "🐦", placeholder: "@handle" },
  { key: "social_steam", label: "Steam", icon: "🎮", placeholder: "steamid" },
  { key: "social_youtube", label: "YouTube", icon: "▶️", placeholder: "@channel" },
  { key: "social_twitch", label: "Twitch", icon: "🟣", placeholder: "channel-name" },
] as const;

function SocialTab({ token, onToast }: { token: string; onToast: (t: string, type?: "info" | "success" | "error") => void }) {
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch(`${API_BASE}/users/@me/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((d) => {
        const v: Record<string, string> = {};
        for (const s of SOCIALS) v[s.key] = d[s.key] ?? "";
        setValues(v);
      })
      .catch((e) => console.warn("[kikkacord] couldn't load social links", e));
  }, [token]);

  async function save() {
    try {
      await fetch(`${API_BASE}/users/@me/profile`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(values),
      });
      onToast("Social links saved", "success");
    } catch {
      onToast("Failed to save", "error");
    }
  }

  return (
    <div>
      <h2 className="mb-2 text-xl font-bold">Social Links</h2>
      <p className="mb-6 text-sm" style={{ color: "var(--text-muted)" }}>
        Connect your other accounts. These appear on your profile card.
      </p>
      {SOCIALS.map((s) => (
        <Field key={s.key} label={`${s.icon} ${s.label}`}>
          <input
            value={values[s.key] ?? ""}
            onChange={(e) => setValues({ ...values, [s.key]: e.target.value })}
            placeholder={s.placeholder}
            className="w-full rounded px-3 py-2 text-sm outline-none"
            style={{ background: "var(--bg-input)", color: "var(--text-primary)" }}
          />
        </Field>
      ))}
      <button
        onClick={save}
        className="mt-2 rounded px-4 py-2 text-sm font-semibold text-white"
        style={{ background: "var(--accent)" }}
      >
        Save Links
      </button>
    </div>
  );
}

// ── Privacy & Security tab ────────────────────────────────────────────────────

const DAY = 86400;
const DEADMAN_PRESETS: { label: string; seconds: number | null }[] = [
  { label: "Off", seconds: null },
  { label: "7 days", seconds: 7 * DAY },
  { label: "30 days", seconds: 30 * DAY },
  { label: "90 days", seconds: 90 * DAY },
];

function SecurityTab({
  token,
  onToast,
}: {
  token: string;
  onToast: (t: string, type?: "info" | "success" | "error") => void;
}) {
  const [seconds, setSeconds] = useState<number | null>(null);
  const [scope, setScope] = useState<"history" | "keys">("history");
  const [confirmBurn, setConfirmBurn] = useState(false);

  useEffect(() => {
    api
      .getDeadman(token)
      .then((c) => {
        setSeconds(c.seconds ?? null);
        setScope(c.scope === "keys" ? "keys" : "history");
      })
      .catch((e) => console.warn("[kikkacord] couldn't load deadman config", e));
  }, [token]);

  async function save(nextSeconds: number | null, nextScope: "history" | "keys") {
    setSeconds(nextSeconds);
    setScope(nextScope);
    try {
      await api.setDeadman(token, nextSeconds, nextScope);
      onToast(nextSeconds ? "Dead man's switch armed" : "Dead man's switch turned off", "success");
    } catch {
      onToast("Couldn't save", "error");
    }
  }

  async function burn() {
    setConfirmBurn(false);
    await burnVault();
    onToast("Vault burned — E2E keys wiped from this device.", "success");
  }

  return (
    <div>
      <h2 className="mb-1 text-xl font-bold">Privacy &amp; Security</h2>
      <p className="mb-6 text-sm" style={{ color: "var(--text-muted)" }}>
        Your messages are end-to-end encrypted with the Signal protocol. These controls decide what
        happens to your data if you disappear — or on demand.
      </p>

      {/* Dead man's switch */}
      <div className="mb-6 rounded-lg p-4" style={{ background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)" }}>
        <div className="mb-1 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          ⏳ Dead man&apos;s switch
        </div>
        <p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
          If you don&apos;t open Kikkacord for this long, your data is wiped automatically.
        </p>
        <div className="mb-3 flex flex-wrap gap-2">
          {DEADMAN_PRESETS.map((p) => {
            const active = (seconds ?? null) === p.seconds;
            return (
              <button
                key={p.label}
                type="button"
                onClick={() => save(p.seconds, scope)}
                className="rounded-full px-3 py-1 text-sm font-semibold"
                style={{
                  background: active ? "var(--accent)" : "var(--bg-input)",
                  color: active ? "#fff" : "var(--text-secondary)",
                }}
              >
                {p.label}
              </button>
            );
          })}
        </div>
        {seconds != null && (
          <div className="flex flex-wrap gap-2">
            {(["history", "keys"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => save(seconds, s)}
                className="rounded px-3 py-1 text-xs"
                style={{
                  background: scope === s ? "var(--bg-hover)" : "transparent",
                  color: scope === s ? "var(--text-primary)" : "var(--text-secondary)",
                  border: "1px solid var(--bg-hover)",
                }}
              >
                {s === "history" ? "Wipe my messages" : "Wipe messages + my encryption keys"}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Desktop vault burn (Tauri only) */}
      {isDesktop() && (
        <div className="rounded-lg p-4" style={{ background: "var(--bg-sidebar)", border: "1px solid var(--danger)" }}>
          <div className="mb-1 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            🔥 Burn keys on this device now
          </div>
          <p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
            On desktop your E2E keys live in locked, non-swappable memory — never plaintext on disk.
            This destroys them (and the keychain key) immediately; you&apos;ll re-establish encryption
            from scratch.
          </p>
          {confirmBurn ? (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={burn}
                className="rounded px-3 py-1.5 text-sm font-semibold"
                style={{ background: "var(--danger)", color: "#fff" }}
              >
                Yes, burn them
              </button>
              <button
                type="button"
                onClick={() => setConfirmBurn(false)}
                className="rounded px-3 py-1.5 text-sm"
                style={{ background: "var(--bg-input)", color: "var(--text-secondary)" }}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmBurn(true)}
              className="rounded px-3 py-1.5 text-sm font-semibold"
              style={{ background: "transparent", color: "var(--danger)", border: "1px solid var(--danger)" }}
            >
              Burn now
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ── Layout helpers ────────────────────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="mb-5">
      <label className="mb-1.5 block text-xs font-bold uppercase" style={{ color: "var(--text-muted)" }}>
        {label}
      </label>
      {hint && <p className="mb-1.5 text-xs" style={{ color: "var(--text-muted)" }}>{hint}</p>}
      {children}
    </div>
  );
}
