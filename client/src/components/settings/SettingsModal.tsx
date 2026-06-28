import { useState, useEffect, useRef, useCallback } from "react";
import type { ProfileSong, ProfileTheme, PublicUser, PushDevice, ServerEmoji, ServerWithChannels } from "../../api";
import { api, getApiBase, getFileBase } from "../../api";
import type { Theme, ThemeVar } from "../../themes";
import {
  BUILTIN_THEMES,
  getCustomThemes,
  saveCustomTheme,
  deleteCustomTheme,
  applyTheme,
  exportTheme,
  importTheme,
  loadTheme,
  createCustomTheme,
  THEME_VAR_GROUPS,
} from "../../themes";
import { isValidHex } from "../../lib/color";
import { safeHttpUrl } from "../../lib/url";
import { PROFILE_PATTERNS, PROFILE_VIBES, ProfileCardView, type ProfileCardData } from "../ProfileCardView";
import type { PluginManager } from "../../plugins/registry";
import { ensureNotificationPermission, isDesktop } from "../../lib/desktop";
import { canUseWebPush, enableContentFreeWebPush } from "../../lib/push";
import { burnVault, exportKeyMaterial, importKeyMaterial } from "../../lib/tauriVault";
import { generateRecoveryCode, encryptBackup, decryptBackup, backupSummary, type BackupBlob, type BackupSummary } from "../../lib/recovery";
import {
  ACCENT_PRESETS,
  APPEARANCE_CHANGED_EVENT,
  applyActiveAppearance,
  applyDensity,
  applyFontScale,
  getActiveAccent,
  loadAccent,
  loadDensity,
  loadFontScale,
  setAccent,
} from "../../lib/appearance";
import { type Density, DENSITIES, FONT_SCALES } from "../../lib/density";
import { pushAppearance } from "../../lib/appearanceSync";
import { LinkedDevices } from "./LinkedDevices";
import type { PrivacyPrefs } from "../../lib/privacyPrefs";

export type Tab = "account" | "profile" | "appearance" | "plugins" | "social" | "emoji" | "security" | "notifications";

const SETTINGS_TABS: Array<{ id: Tab; label: string; description: string }> = [
  { id: "account", label: "Account", description: "Login and basics" },
  { id: "profile", label: "Profile", description: "How people see you" },
  { id: "social", label: "Social links", description: "Your places online" },
  { id: "security", label: "Privacy & security", description: "Keys and safety" },
  { id: "notifications", label: "Notifications", description: "Mobile + PWA push" },
  { id: "appearance", label: "Appearance", description: "Colors and comfort" },
  { id: "plugins", label: "Plugins", description: "Extra powers" },
  { id: "emoji", label: "Custom emoji", description: "Server reactions" },
];

type Props = {
  currentUser: PublicUser | null;
  pluginManager: PluginManager;
  token: string;
  servers: ServerWithChannels[];
  /** Open straight to a given tab (e.g. the recovery-code nudge deep-links to "security"). */
  initialTab?: Tab;
  onClose: () => void;
  onToast: (text: string, type?: "info" | "success" | "error") => void;
  privacyPrefs: PrivacyPrefs;
  onPrivacyPrefsChange: (prefs: PrivacyPrefs) => void | Promise<void>;
  onCurrentUserUpdate?: (user: PublicUser) => void;
};

const SETTINGS_FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), textarea, select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

export function SettingsModal({ currentUser, pluginManager, token, servers, initialTab, onClose, onToast, privacyPrefs, onPrivacyPrefsChange, onCurrentUserUpdate }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "appearance");
  const dialogRef = useRef<HTMLDivElement>(null);
  // Keep onClose current without re-running the focus-management effect.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Accessible dialog behavior: focus the first control on open, close on Escape,
  // and hand focus back to whatever was focused before, on close.
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>(SETTINGS_FOCUSABLE)?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      returnTo?.focus?.();
    };
  }, []);

  // Trap Tab focus inside the dialog so keyboard users can't tab behind the scrim.
  function trapTab(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(SETTINGS_FOCUSABLE);
    if (!nodes || !nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- dismiss scrim; Escape handled via the keydown effect above
    <div
      className="fixed inset-0 z-50 flex items-stretch"
      style={{ background: "rgba(0,0,0,0.7)" }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- focus-trap dialog container; keyboard handled via onKeyDown, dialog semantics on role="dialog" */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="kc-settings-dialog-title"
        className="flex h-full w-full overflow-hidden"
        style={{ background: "var(--bg-channel)" }}
        onKeyDown={trapTab}
      >
        {/* Settings sidebar */}
        <aside className="kc-settings-sidebar" aria-label="Settings sections">
          <div className="kc-settings-sidebar__brand">
            <div className="kc-settings-sidebar__mark" aria-hidden="true">OH</div>
            <div>
              <div className="kc-settings-sidebar__eyebrow">Settings</div>
              <h2 id="kc-settings-dialog-title" className="kc-settings-sidebar__title">Make Ohiyo yours</h2>
            </div>
          </div>

          <nav className="kc-settings-nav" aria-label="Settings">
            <div className="kc-settings-nav__label">Personal</div>
            {SETTINGS_TABS.slice(0, 5).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`kc-settings-nav__item${tab === item.id ? " kc-settings-nav__item--active" : ""}`}
                aria-current={tab === item.id ? "page" : undefined}
              >
                <span className="kc-settings-nav__dot" aria-hidden="true" />
                <span className="kc-settings-nav__text">
                  <span>{item.label}</span>
                  <small>{item.description}</small>
                </span>
              </button>
            ))}

            <div className="kc-settings-nav__label kc-settings-nav__label--spaced">Make it comfy</div>
            {SETTINGS_TABS.slice(5).map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`kc-settings-nav__item${tab === item.id ? " kc-settings-nav__item--active" : ""}`}
                aria-current={tab === item.id ? "page" : undefined}
              >
                <span className="kc-settings-nav__dot" aria-hidden="true" />
                <span className="kc-settings-nav__text">
                  <span>{item.label}</span>
                  <small>{item.description}</small>
                </span>
              </button>
            ))}
          </nav>

          <div className="kc-settings-sidebar__footer">
            <div className="kc-settings-sidebar__hint">
              <span aria-hidden="true" />
              Changes save as you go.
            </div>
            <button type="button" onClick={onClose} className="kc-settings-close kc-interactive">
              Back to Ohiyo
            </button>
          </div>
        </aside>

        {/* Settings content */}
        <div className="kc-settings-content flex-1 overflow-y-auto px-10 py-14">
          {tab === "appearance" && <AppearanceTab onToast={onToast} token={token} />}
          {tab === "plugins" && <PluginsTab pluginManager={pluginManager} onToast={onToast} />}
          {tab === "account" && <AccountTab currentUser={currentUser} token={token} onToast={onToast} onCurrentUserUpdate={onCurrentUserUpdate} />}
          {tab === "profile" && <ProfileTab token={token} onToast={onToast} />}
          {tab === "social" && <SocialTab token={token} onToast={onToast} />}
          {tab === "security" && <SecurityTab token={token} onToast={onToast} privacyPrefs={privacyPrefs} onPrivacyPrefsChange={onPrivacyPrefsChange} />}
          {tab === "notifications" && <NotificationsTab token={token} onToast={onToast} />}
          {tab === "emoji" && <EmojiTab token={token} servers={servers} onToast={onToast} />}
        </div>
      </div>
    </div>
  );
}

// ── Appearance tab ────────────────────────────────────────────────────────────

function AppearanceTab({
  onToast,
  token,
}: {
  onToast: (t: string, type?: "info" | "success" | "error") => void;
  token: string;
}) {
  const [currentTheme, setCurrentTheme] = useState<Theme>(loadTheme);
  const [customThemes, setCustomThemes] = useState<Theme[]>(getCustomThemes);
  const [importText, setImportText] = useState("");
  const [accent, setAccentVal] = useState<string>(getActiveAccent);
  const [accentOverride, setAccentOverride] = useState<boolean>(() => loadAccent() !== null);
  const [density, setDensityVal] = useState<Density>(loadDensity);
  const [fontScale, setFontScaleVal] = useState<number>(loadFontScale);

  const allThemes = [...BUILTIN_THEMES, ...customThemes];
  const activePreset = ACCENT_PRESETS.find((p) => accent.toLowerCase() === p.hex.toLowerCase());
  const isCustomAccent = accentOverride && !activePreset;
  const editorGroupName = (group: string) => (group === "Accents" ? "Highlights" : group);
  const editorColorName = (label: string) => ({
    Base: "App background",
    Sidebar: "Sidebar",
    Channel: "Chat background",
    Input: "Message boxes",
    Hover: "Hover shade",
    Primary: "Main text",
    Secondary: "Soft text",
    Muted: "Quiet text",
    Accent: "Main highlight",
    "Accent hover": "Highlight hover",
    Success: "Success",
    Danger: "Warning",
  } satisfies Record<string, string>)[label] ?? label;

  function select(theme: Theme) {
    applyTheme(theme);
    setCurrentTheme(theme);
    // Keep a personal accent layered over the new theme; otherwise follow the theme.
    const ov = loadAccent();
    if (ov) setAccent(ov);
    setAccentVal(ov ?? theme.vars["--accent"]);
    pushAppearance(token);
    onToast(`Theme "${theme.name}" applied`, "success");
  }

  function chooseAccent(hex: string) {
    setAccent(hex);
    setAccentVal(hex);
    setAccentOverride(true);
    pushAppearance(token);
  }

  function chooseDensity(d: Density) {
    applyDensity(d);
    setDensityVal(d);
    pushAppearance(token);
  }

  function chooseFontScale(s: number) {
    applyFontScale(s);
    setFontScaleVal(s);
    pushAppearance(token);
  }

  function resetAccent() {
    setAccent(null);
    setAccentVal(currentTheme.vars["--accent"]);
    setAccentOverride(false);
    pushAppearance(token);
    onToast("Accent reset to theme default", "success");
  }

  // ── Visual theme editor ──────────────────────────────────────────────────
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftVars, setDraftVars] = useState<ThemeVar>(() => ({ ...currentTheme.vars }));

  // Local state is seeded once at mount. When another device's appearance arrives via
  // pullAppearance (or any other code applies a change), the DOM updates but these
  // controls would show stale values and re-push them. Re-seed from the persisted source
  // on APPEARANCE_CHANGED_EVENT so the controls follow. Skip while the editor is open so
  // a live preview doesn't get clobbered mid-edit.
  useEffect(() => {
    const onAppearanceChanged = () => {
      if (editing) return;
      setCurrentTheme(loadTheme());
      setCustomThemes(getCustomThemes());
      setAccentVal(getActiveAccent());
      setAccentOverride(loadAccent() !== null);
      setDensityVal(loadDensity());
      setFontScaleVal(loadFontScale());
    };
    window.addEventListener(APPEARANCE_CHANGED_EVENT, onAppearanceChanged);
    return () => window.removeEventListener(APPEARANCE_CHANGED_EVENT, onAppearanceChanged);
  }, [editing]);

  function openEditor() {
    setDraftVars({ ...currentTheme.vars });
    setDraftName("");
    setEditing(true);
  }

  function editVar(key: keyof ThemeVar, value: string) {
    document.documentElement.style.setProperty(key, value); // live preview
    setDraftVars((prev) => ({ ...prev, [key]: value }));
  }

  function cancelEditor() {
    setEditing(false);
    applyActiveAppearance(); // restore the real active theme + accent
  }

  function saveEditor() {
    const theme = createCustomTheme(draftName, draftVars);
    saveCustomTheme(theme);
    setCustomThemes(getCustomThemes());
    applyTheme(theme);
    setAccent(null); // the edited theme's own accent wins; drop any override
    setCurrentTheme(theme);
    setAccentVal(theme.vars["--accent"]);
    setAccentOverride(false);
    setEditing(false);
    pushAppearance(token);
    onToast(`Theme "${theme.name}" saved`, "success");
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
    <div className="kc-appearance">
      <section className="kc-appearance-hero">
        <div>
          <div className="kc-kicker">Your space</div>
          <h2>Make Ohiyo comfy for you.</h2>
          <p>
            Start with quick tweaks, or pick a whole theme below. Two or three clicks is enough —
            Ohiyo updates right away and you can change it anytime.
          </p>
        </div>
        <div className="kc-appearance-hero__preview" aria-hidden="true">
          <span className="kc-preview-dot" />
          <span className="kc-preview-line" />
          <span className="kc-preview-pill">Updates instantly</span>
        </div>
      </section>

      <section className="kc-settings-stage kc-settings-stage--primary" aria-labelledby="quick-tweaks-title">
        <div className="kc-section-head">
          <div>
            <span className="kc-step-pill">Step 1</span>
            <h3 id="quick-tweaks-title">Quick tweaks</h3>
            <p>Start here. Pick a favorite color, choose comfy spacing, and set text size — then you can be done.</p>
          </div>
        </div>

        <div className="kc-quick-tweaks">
          {/* Accent color — recolors the whole app, layered over any theme. */}
          <section className="kc-settings-card kc-settings-card--compact">
            <div className="kc-settings-card__head">
              <div>
                <div className="kc-settings-card__title">Favorite color</div>
                <p>This is the little color that shows up on buttons, links, and selected things.</p>
              </div>
              {accentOverride && <span className="kc-settings-chip">Custom</span>}
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              {ACCENT_PRESETS.map((p) => {
                const isActive = accent.toLowerCase() === p.hex.toLowerCase();
                return (
                  <button
                    key={p.hex}
                    type="button"
                    title={`${p.name}${isActive ? " selected" : ""}`}
                    aria-label={`${isActive ? "Selected accent" : "Choose accent"}: ${p.name}`}
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
                  boxShadow: isCustomAccent ? "0 0 0 2px var(--bg-channel), 0 0 0 4px var(--text-primary)" : undefined,
                }}
              >
                <input
                  type="color"
                  value={accent}
                  onChange={(e) => chooseAccent(e.target.value)}
                  aria-label={isCustomAccent ? `Selected custom accent ${accent}` : "Pick a custom accent color"}
                  style={{ position: "absolute", inset: 0, opacity: 0, cursor: "pointer" }}
                />
                <span
                  aria-hidden="true"
                  style={{ color: "#fff", fontSize: isCustomAccent ? 12 : 14, fontWeight: 700, textShadow: "0 1px 2px rgba(0,0,0,.45)" }}
                >
                  {isCustomAccent ? "✓" : "+"}
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
          </section>

          <div className="kc-preference-grid">
            {/* Message density — how tightly messages pack. Synced cross-device like accent. */}
            <section className="kc-settings-card kc-settings-card--compact">
              <div className="kc-settings-card__head">
                <div>
                  <div className="kc-settings-card__title">Chat spacing</div>
                  <p>Make messages tighter, cozy, or extra roomy.</p>
                </div>
              </div>
              <div className="kc-seg" role="group" aria-label="Message density">
                {DENSITIES.map((d) => (
                  <button
                    key={d}
                    type="button"
                    className="kc-seg__btn"
                    aria-pressed={density === d}
                    onClick={() => chooseDensity(d)}
                  >
                    {d[0].toUpperCase() + d.slice(1)}
                  </button>
                ))}
              </div>
            </section>

            {/* Font size — scales the chat text; the message list re-measures on change. */}
            <section className="kc-settings-card kc-settings-card--compact">
              <div className="kc-settings-card__head">
                <div>
                  <div className="kc-settings-card__title">Text size</div>
                  <p>Make chat easier to read without changing everything else.</p>
                </div>
              </div>
              <div className="kc-seg" role="group" aria-label="Font size">
                {FONT_SCALES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="kc-seg__btn"
                    aria-pressed={fontScale === s}
                    onClick={() => chooseFontScale(s)}
                  >
                    {Math.round(s * 100)}%
                  </button>
                ))}
              </div>
            </section>
          </div>
        </div>
      </section>

      <section className="kc-settings-stage kc-theme-section" aria-labelledby="choose-theme-title">
        <div className="kc-section-head kc-section-head--inline">
          <div>
            <span className="kc-step-pill">Step 2</span>
            <h3 id="choose-theme-title">Choose a theme</h3>
            <p>Prefer one-and-done? Pick a whole look here. Quick tweaks above still stay easy to change.</p>
          </div>
          <div className="kc-settings-chip kc-settings-chip--soft">
            Using {currentTheme.name}
          </div>
        </div>

        <div className="kc-theme-grid grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {allThemes.map((theme) => {
            const isSelected = currentTheme.id === theme.id;
            const isCustom = !BUILTIN_THEMES.find((b) => b.id === theme.id);
            const isRecommended = theme.id === "chrome-blue";
            return (
              <div key={theme.id} className="kc-theme-card-wrap">
                <button
                  type="button"
                  aria-pressed={isSelected}
                  aria-label={`${isSelected ? "Selected theme" : "Use theme"}: ${theme.name}`}
                  onClick={() => select(theme)}
                  className="kc-theme-card kc-interactive relative cursor-pointer overflow-hidden rounded-2xl"
                  style={{
                    border: `1.5px solid ${isSelected ? theme.vars["--accent"] : "color-mix(in oklch, var(--text-primary) 10%, transparent)"}`,
                    background: theme.vars["--bg-channel"],
                    boxShadow: isSelected ? `0 0 0 1px ${theme.vars["--accent"]}, 0 18px 42px -34px ${theme.vars["--accent"]}` : undefined,
                  }}
                >
                  {isSelected && <span className="kc-theme-card__selected">✓ Selected</span>}
                  <div className="p-3" style={{ background: `linear-gradient(135deg, ${theme.vars["--bg-sidebar"]}, ${theme.vars["--bg-base"]})` }}>
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5" aria-hidden="true">
                        {["--accent", "--green", "--danger"].map((v) => (
                          <span
                            key={v}
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ background: theme.vars[v as keyof typeof theme.vars] }}
                          />
                        ))}
                      </div>
                      {isRecommended && (
                        <span
                          className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
                          style={{ background: theme.vars["--accent"], color: "white" }}
                        >
                          Recommended
                        </span>
                      )}
                    </div>
                    <div className="space-y-2 rounded-xl p-3" style={{ background: theme.vars["--bg-channel"] }} aria-hidden="true">
                      <div className="h-2 w-20 rounded-full" style={{ background: theme.vars["--text-muted"], opacity: 0.45 }} />
                      <div className="flex items-center gap-2">
                        <span className="h-7 w-7 rounded-full" style={{ background: theme.vars["--accent"] }} />
                        <span className="h-8 flex-1 rounded-full" style={{ background: theme.vars["--bg-input"], border: `1px solid ${theme.vars["--bg-hover"]}` }} />
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3 px-3 py-2.5" style={{ background: theme.vars["--bg-channel"] }}>
                    <div className="min-w-0 text-left">
                      <div className="truncate text-sm font-bold" style={{ color: theme.vars["--text-primary"] }}>
                        {theme.name}
                      </div>
                      <div className="text-[11px]" style={{ color: theme.vars["--text-muted"] }}>
                        {isSelected ? "Using this now" : isCustom ? "Made by you" : "Tap to try"}
                      </div>
                    </div>
                    {isSelected && (
                      <span
                        className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold"
                        style={{ background: theme.vars["--accent"], color: "white" }}
                        aria-hidden="true"
                      >
                        ✓
                      </span>
                    )}
                  </div>
                </button>
                {isCustom && !isSelected && (
                  <button
                    type="button"
                    onClick={() => handleDeleteCustom(theme.id)}
                    className="kc-theme-card__remove kc-interactive rounded-full px-2 py-1 text-xs font-semibold"
                  >
                    Remove
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Build your own theme — visual editor (no JSON required) */}
      <section className="kc-settings-stage kc-theme-builder" aria-labelledby="theme-builder-title">
        {!editing ? (
          <div className="kc-theme-builder__closed">
            <div>
              <span className="kc-step-pill kc-step-pill--muted">Step 3 · Optional</span>
              <h3 id="theme-builder-title">Fine-tune your own look</h3>
              <p>Only open this if you want exact colors. Most people can stop after picking a favorite above.</p>
            </div>
            <button
              type="button"
              onClick={openEditor}
              className="kc-theme-builder__button kc-interactive rounded-full px-4 py-2 text-sm font-semibold"
            >
              Customize colors
            </button>
          </div>
        ) : (
          <div className="kc-theme-editor rounded-2xl p-4">
            <div className="kc-theme-editor__head">
              <div>
                <span className="kc-step-pill kc-step-pill--muted">Step 3 · Optional</span>
                <div className="kc-theme-editor__title">Fine-tune your own look</div>
                <p className="kc-theme-editor__copy">
                  Pick a color, watch Ohiyo update instantly, then save it as your own look.
                </p>
              </div>
              <div className="kc-theme-editor__preview" aria-hidden="true">
                <div className="kc-theme-editor__preview-dots"><span /><span /><span /></div>
                <div className="kc-theme-editor__preview-line" />
                <div className="kc-theme-editor__preview-message">
                  <span style={{ background: draftVars["--accent"] }} />
                  <div>
                    <b style={{ color: draftVars["--text-primary"] }}>Preview</b>
                    <small style={{ color: draftVars["--text-muted"] }}>This is how your colors feel.</small>
                  </div>
                </div>
              </div>
            </div>

            <label className="kc-theme-name-field">
              <span>Name your look</span>
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder="e.g. Night Study"
                aria-label="Theme name"
              />
            </label>

            <div className="kc-theme-editor__groups">
              {THEME_VAR_GROUPS.map((grp) => (
                <div key={grp.group} className="kc-theme-color-group">
                  <div className="kc-theme-color-group__title">{editorGroupName(grp.group)}</div>
                  <div className="kc-theme-color-grid">
                    {grp.vars.map((v) => (
                      <label key={v.key} className="kc-theme-color-card">
                        <span
                          className="kc-theme-color-card__swatch"
                          style={{ background: isValidHex(draftVars[v.key]) ? draftVars[v.key] : "#000000" }}
                          aria-hidden="true"
                        />
                        <span className="kc-theme-color-card__text">
                          <span>{editorColorName(v.label)}</span>
                          <code>{isValidHex(draftVars[v.key]) ? draftVars[v.key].toUpperCase() : "#000000"}</code>
                        </span>
                        <input
                          type="color"
                          value={isValidHex(draftVars[v.key]) ? draftVars[v.key] : "#000000"}
                          onChange={(e) => editVar(v.key, e.target.value)}
                          aria-label={`${editorGroupName(grp.group)} ${editorColorName(v.label)} color`}
                        />
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="kc-theme-editor__actions">
              <button type="button" onClick={saveEditor} className="kc-cta px-4 py-2 text-sm">
                Save this look
              </button>
              <button type="button" onClick={cancelEditor} className="kc-interactive rounded-full px-4 py-2 text-sm font-semibold">
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Export / Import (advanced) */}
      <details className="kc-advanced-theme rounded-2xl p-4">
        <summary className="cursor-pointer text-sm font-semibold" style={{ color: "var(--text-secondary)" }}>
          <span className="kc-step-pill kc-step-pill--muted">Step 4 · Optional</span>
          Share or import a look
        </summary>
        <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
          For when a friend sends you a look, or you want to copy yours to another device.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => handleExport(currentTheme)}
            className="kc-interactive rounded-full px-3 py-1.5 text-sm font-semibold"
            style={{ background: "var(--bg-input)", color: "var(--text-primary)", border: "1px solid var(--bg-hover)" }}
          >
            Copy this look
          </button>
        </div>
        <textarea
          placeholder="Paste a look here…"
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          rows={4}
          className="mt-3 mb-2 w-full rounded-xl p-3 text-xs outline-none font-mono"
          style={{ background: "var(--bg-input)", color: "var(--text-primary)", resize: "vertical", border: "1px solid var(--bg-hover)" }}
        />
        <button
          type="button"
          onClick={handleImport}
          disabled={!importText.trim()}
          className="rounded-full px-3 py-1.5 text-sm font-semibold"
          style={{ background: importText.trim() ? "var(--accent)" : "var(--bg-hover)", color: "white", opacity: importText.trim() ? 1 : 0.65 }}
        >
          Add this look
        </button>
      </details>
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
          Paste a URL to a JavaScript ES module that exports a default OhiyoPlugin object.
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

function AccountTab({ currentUser, token, onToast, onCurrentUserUpdate }: { currentUser: PublicUser | null; token: string; onToast: (t: string, type?: "info" | "success" | "error") => void; onCurrentUserUpdate?: (user: PublicUser) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(currentUser?.avatar_url ?? null);

  if (!currentUser) return null;

  async function handleAvatarUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch(`${getApiBase()}/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const data = await res.json() as Array<{ id: string; url: string }>;
      const fileId = data[0]?.id;
      if (!fileId) throw new Error("Upload failed");
      const updated = await api.setAvatar(token, fileId);
      setAvatarUrl(updated.avatar_url ?? `${getFileBase()}/files/${fileId}`);
      onCurrentUserUpdate?.(updated);
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
  const selectedServer = servers.find((s) => s.id === selectedServerId) ?? null;

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
      const res = await fetch(`${getApiBase()}/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!res.ok) throw new Error(await res.text());
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
          {selectedServer && (
            <div className="mb-3 flex items-center gap-3 rounded-xl p-3" style={{ background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)" }}>
              <div className="flex h-11 w-11 items-center justify-center overflow-hidden rounded-xl text-sm font-bold" style={{ background: "var(--accent)", color: "#fff" }}>
                {selectedServer.icon_url ? <img src={selectedServer.icon_url} alt="" className="h-full w-full object-cover" /> : selectedServer.name.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{selectedServer.name}</div>
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>Emoji will be added to this server.</div>
              </div>
            </div>
          )}
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
                  <img src={`${getFileBase()}${e.url}`} alt={`:${e.name}:`} className="h-8 w-8 rounded object-contain" style={{ imageRendering: "pixelated" }} />
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

function cleanSongs(songs: ProfileSong[]): ProfileSong[] {
  return songs
    .map((s) => ({
      title: s.title.trim(),
      artist: s.artist?.trim() || null,
      // Reject non-http(s) schemes (e.g. javascript:) at the input boundary so a
      // crafted URL never reaches the rendered profile link.
      url: safeHttpUrl(s.url?.trim()) ?? null,
    }))
    .filter((s) => s.title)
    .slice(0, 3);
}

function padSongs(songs: ProfileSong[]): ProfileSong[] {
  const clean = cleanSongs(songs);
  while (clean.length < 3) clean.push({ title: "", artist: "", url: "" });
  return clean.slice(0, 3);
}

function ProfileTab({ token, onToast }: { token: string; onToast: (t: string, type?: "info" | "success" | "error") => void }) {
  const [bio, setBio] = useState("");
  const [status, setStatus] = useState("");
  const [bannerColor, setBannerColor] = useState("#5865f2");
  const [profileTheme, setProfileTheme] = useState<ProfileTheme>({
    vibe: "sunset",
    accent: "#ff7a45",
    pattern: "stars",
    glow: true,
    emoji: "✨",
    showStatus: true,
    showBio: true,
    showActive: true,
    showSongs: true,
    showSocials: true,
  });
  const [topSongs, setTopSongs] = useState<ProfileSong[]>([{ title: "", artist: "", url: "" }, { title: "", artist: "", url: "" }, { title: "", artist: "", url: "" }]);
  const [bannerUrl, setBannerUrl] = useState<string | null>(null);
  const bannerFileRef = useRef<HTMLInputElement>(null);
  // Read-only base fields (name, @handle, avatar, socials) used by the live preview.
  const [base, setBase] = useState<Partial<ProfileCardData>>({});

  useEffect(() => {
    fetch(`${getApiBase()}/users/@me/profile`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((r) => r.json())
      .then((d) => {
        setBio(d.bio ?? "");
        setStatus(d.custom_status ?? "");
        setBannerColor(d.banner_color ?? "#f2683c");
        setProfileTheme({
          showStatus: true,
          showBio: true,
          showActive: true,
          showSongs: true,
          showSocials: true,
          ...(d.profile_theme ?? { vibe: "sunset", accent: d.banner_color ?? "#ff7a45", pattern: "stars", glow: true, emoji: "✨" }),
        });
        setTopSongs(padSongs(d.top_songs ?? []));
        setBannerUrl(d.banner_url ?? null);
        setBase({
          username: d.username,
          display_name: d.display_name,
          avatar_url: d.avatar_url ?? null,
          last_active_at: d.last_active_at ?? null,
          social_github: d.social_github ?? null,
          social_twitter: d.social_twitter ?? null,
          social_youtube: d.social_youtube ?? null,
          social_twitch: d.social_twitch ?? null,
          social_steam: d.social_steam ?? null,
          social_spotify: d.social_spotify ?? null,
        });
      })
      .catch((e) => console.warn("[kikkacord] couldn't load profile", e));
  }, [token]);

  async function save() {
    try {
      await fetch(`${getApiBase()}/users/@me/profile`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ bio, banner_color: bannerColor, custom_status: status, profile_theme: profileTheme, top_songs: cleanSongs(topSongs) }),
      });
      onToast("Profile saved", "success");
    } catch {
      onToast("Failed to save", "error");
    }
  }

  async function handleBannerUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch(`${getApiBase()}/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const data = (await res.json()) as Array<{ id: string; url: string }>;
      const fileId = data[0]?.id;
      if (!fileId) throw new Error("Upload failed");
      await api.setBanner(token, fileId);
      setBannerUrl(`${getFileBase()}/files/${fileId}`); // local preview reflects it immediately
      onToast("Banner image updated!", "success");
    } catch (err) {
      onToast(`Banner upload failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  // Live preview data: saved base fields overlaid with the in-progress edits.
  const preview: ProfileCardData = {
    display_name: base.display_name ?? "Your name",
    username: base.username ?? "username",
    avatar_url: base.avatar_url ?? null,
    last_active_at: base.last_active_at ?? null,
    custom_status: status,
    bio,
    banner_color: bannerColor,
    banner_url: bannerUrl,
    profile_theme: profileTheme,
    top_songs: cleanSongs(topSongs),
    social_github: base.social_github ?? null,
    social_twitter: base.social_twitter ?? null,
    social_youtube: base.social_youtube ?? null,
    social_twitch: base.social_twitch ?? null,
    social_steam: base.social_steam ?? null,
    social_spotify: base.social_spotify ?? null,
  };

  return (
    <div>
      <h2 className="mb-1 text-xl font-bold">Profile</h2>
      <p className="mb-6 text-sm" style={{ color: "var(--text-muted)" }}>
        Edit on the left — see exactly how others see you on the right.
      </p>
      <div className="flex flex-col gap-6 lg:flex-row">
        <div className="flex-1">
          <Field label="Custom Status" hint="Shown below your username">
            <input
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              placeholder="Building something cool..."
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
          <Field label="Top 3 Songs" hint="Show your current favorites on your profile. Link is optional.">
            <div className="flex flex-col gap-2">
              {topSongs.map((song, i) => (
                <div
                  key={i}
                  className="rounded-xl border p-2"
                  style={{ background: "var(--bg-input)", borderColor: "var(--bg-hover)" }}
                >
                  <div className="mb-1 text-[10px] font-bold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
                    Song {i + 1}
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <input
                      value={song.title}
                      onChange={(e) => setTopSongs((prev) => prev.map((s, idx) => idx === i ? { ...s, title: e.target.value } : s))}
                      placeholder="Song title"
                      className="rounded px-3 py-2 text-sm outline-none"
                      style={{ background: "var(--bg-sidebar)", color: "var(--text-primary)" }}
                    />
                    <input
                      value={song.artist ?? ""}
                      onChange={(e) => setTopSongs((prev) => prev.map((s, idx) => idx === i ? { ...s, artist: e.target.value } : s))}
                      placeholder="Artist"
                      className="rounded px-3 py-2 text-sm outline-none"
                      style={{ background: "var(--bg-sidebar)", color: "var(--text-primary)" }}
                    />
                  </div>
                  <input
                    value={song.url ?? ""}
                    onChange={(e) => setTopSongs((prev) => prev.map((s, idx) => idx === i ? { ...s, url: e.target.value } : s))}
                    placeholder="Spotify / YouTube / SoundCloud link"
                    className="mt-2 w-full rounded px-3 py-2 text-sm outline-none"
                    style={{ background: "var(--bg-sidebar)", color: "var(--text-primary)" }}
                  />
                </div>
              ))}
            </div>
          </Field>
          <Field label="Banner Color">
            <div className="flex items-center gap-3">
              <input
                type="color"
                value={isValidHex(bannerColor) ? bannerColor : "#5865f2"}
                onChange={(e) => {
                  setBannerColor(e.target.value);
                  setProfileTheme((t) => ({ ...t, accent: t.vibe === "custom" ? e.target.value : t.accent }));
                }}
                aria-label="Banner color"
                className="kc-color-input"
              />
              <span className="text-sm font-mono" style={{ color: "var(--text-secondary)" }}>
                {bannerColor}
              </span>
            </div>
          </Field>
          <Field label="Profile Vibe" hint="Controls the card glow, gradient, sticker, and pattern.">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {Object.entries(PROFILE_VIBES).map(([id, vibe]) => {
                const active = (profileTheme.vibe ?? "sunset") === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setProfileTheme((t) => ({ ...t, vibe: id as ProfileTheme["vibe"], accent: vibe.a }))}
                    className="kc-interactive rounded-xl px-3 py-2 text-left text-xs font-bold"
                    style={{
                      border: `1px solid ${active ? vibe.a : "var(--bg-hover)"}`,
                      background: `linear-gradient(135deg, ${vibe.a}, ${vibe.b})`,
                      color: "#fff",
                      boxShadow: active ? `0 0 0 2px color-mix(in oklch, ${vibe.a} 36%, transparent)` : undefined,
                    }}
                  >
                    {vibe.label}
                  </button>
                );
              })}
              <button
                type="button"
                onClick={() => setProfileTheme((t) => ({ ...t, vibe: "custom", accent: bannerColor }))}
                className="kc-interactive rounded-xl px-3 py-2 text-left text-xs font-bold"
                style={{ border: `1px solid ${profileTheme.vibe === "custom" ? bannerColor : "var(--bg-hover)"}`, background: "var(--bg-input)", color: "var(--text-primary)" }}
              >
                Custom
              </button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
                Accent
                <input
                  type="color"
                  value={isValidHex(profileTheme.accent ?? "") ? profileTheme.accent : bannerColor}
                  onChange={(e) => setProfileTheme((t) => ({ ...t, vibe: "custom", accent: e.target.value }))}
                  aria-label="Profile accent"
                  className="kc-color-input"
                />
              </label>
              <label className="flex items-center gap-2 text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
                Sticker
                <input
                  value={profileTheme.emoji ?? ""}
                  onChange={(e) => setProfileTheme((t) => ({ ...t, emoji: e.target.value.slice(0, 2) }))}
                  placeholder="✨"
                  className="w-16 rounded px-2 py-1 text-sm outline-none"
                  style={{ background: "var(--bg-input)", color: "var(--text-primary)" }}
                />
              </label>
              <label className="flex items-center gap-2 text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
                <input
                  type="checkbox"
                  checked={profileTheme.glow ?? true}
                  onChange={(e) => setProfileTheme((t) => ({ ...t, glow: e.target.checked }))}
                />
                Glow
              </label>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              {PROFILE_PATTERNS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setProfileTheme((t) => ({ ...t, pattern: p.id }))}
                  className="kc-interactive rounded-full px-3 py-1.5 text-xs font-semibold"
                  style={{
                    border: "none",
                    background: (profileTheme.pattern ?? "stars") === p.id ? "var(--accent)" : "var(--bg-input)",
                    color: (profileTheme.pattern ?? "stars") === p.id ? "#fff" : "var(--text-secondary)",
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Show / Hide Sections" hint="Leave fields filled in, but choose what appears publicly.">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {([
                ["showStatus", "Status"],
                ["showBio", "Bio"],
                ["showActive", "Active badge"],
                ["showSongs", "Top songs"],
                ["showSocials", "Socials"],
              ] as const).map(([key, label]) => {
                const on = profileTheme[key] ?? true;
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setProfileTheme((t) => ({ ...t, [key]: !(t[key] ?? true) }))}
                    className="kc-interactive rounded-full px-3 py-2 text-xs font-bold"
                    style={{
                      border: "none",
                      background: on ? "color-mix(in oklch, var(--accent) 18%, transparent)" : "var(--bg-input)",
                      color: on ? "var(--accent)" : "var(--text-muted)",
                    }}
                  >
                    {on ? "✓" : "○"} {label}
                  </button>
                );
              })}
            </div>
          </Field>
          <Field label="Banner Image">
            <div className="flex items-center gap-3">
              <div
                className="h-12 w-24 flex-shrink-0 rounded overflow-hidden"
                style={{ background: isValidHex(bannerColor) ? bannerColor : "#5865f2" }}
              >
                {bannerUrl && (
                  <img src={bannerUrl} alt="" className="h-full w-full object-cover" />
                )}
              </div>
              <button
                type="button"
                onClick={() => bannerFileRef.current?.click()}
                className="rounded px-3 py-1.5 text-xs font-semibold"
                style={{ background: "var(--accent)", color: "#fff" }}
              >
                {bannerUrl ? "Replace image" : "Upload image"}
              </button>
              <input
                ref={bannerFileRef}
                type="file"
                accept="image/*,.gif"
                className="hidden"
                onChange={handleBannerUpload}
              />
            </div>
            <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
              An image covers the banner color. GIFs supported.
            </p>
          </Field>
          <button
            onClick={save}
            className="mt-2 rounded px-4 py-2 text-sm font-semibold text-white"
            style={{ background: "var(--accent)" }}
          >
            Save Profile
          </button>
        </div>

        {/* Live preview — exactly the card others see on hover */}
        <div className="flex-shrink-0 lg:w-[300px]">
          <div
            className="mb-2 text-xs font-bold uppercase"
            style={{ color: "var(--text-muted)", letterSpacing: "0.04em" }}
          >
            Live preview
          </div>
          <div
            style={{
              borderRadius: "var(--radius-xl)",
              overflow: "hidden",
              boxShadow: "var(--shadow-lg)",
              background: "var(--bg-sidebar)",
              border: "1px solid var(--bg-hover)",
            }}
          >
            <ProfileCardView data={preview} preview />
          </div>
        </div>
      </div>
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
    fetch(`${getApiBase()}/users/@me/profile`, {
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
      await fetch(`${getApiBase()}/users/@me/profile`, {
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

// ── Notifications tab ────────────────────────────────────────────────────────

function NotificationsTab({ token, onToast }: { token: string; onToast: (t: string, type?: "info" | "success" | "error") => void }) {
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [privacyNote, setPrivacyNote] = useState("Push notifications are content-free.");
  const [serverPushEnabled, setServerPushEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [cfg, list] = await Promise.all([api.getPushConfig(), api.listPushDevices(token)]);
      setPrivacyNote(cfg.privacy_note);
      setServerPushEnabled(cfg.enabled);
      setDevices(list);
    } catch (err) {
      console.warn("[ohiyo] couldn't load push settings", err);
    }
  }, [token]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function enableLocalNotifications() {
    await ensureNotificationPermission();
    onToast("Local notifications enabled for this device when Ohiyo is open.", "success");
  }

  async function enablePush() {
    setBusy(true);
    try {
      await enableContentFreeWebPush(token);
      await refresh();
      onToast("Content-free push enabled for this PWA/browser.", "success");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Couldn't enable push.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try {
      await api.deletePushDevice(token, id);
      setDevices((prev) => prev.filter((d) => d.id !== id));
      onToast("Push device removed.", "success");
    } catch {
      onToast("Couldn't remove device.", "error");
    }
  }

  return (
    <div>
      <h2 className="mb-1 text-xl font-bold">Notifications &amp; mobile</h2>
      <p className="mb-6 max-w-3xl text-sm leading-6" style={{ color: "var(--text-muted)" }}>
        Ohiyo push is designed for sleeping Instant Servers: the server wakes to accept ciphertext, then the always-on relay sends a generic nudge. Push payloads do not include message text, filenames, channel names, or E2E keys.
      </p>

      <div className="mb-6 grid gap-3 md:grid-cols-2">
        <div className="rounded-lg p-4" style={{ background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)" }}>
          <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>📱 Mobile/PWA install</div>
          <p className="mt-2 text-xs leading-5" style={{ color: "var(--text-muted)" }}>
            On iPhone/Android, open Ohiyo in the browser menu and choose <b>Add to Home Screen</b>. The installed app gets standalone chrome, safe-area layout, and the Ohiyo service worker.
          </p>
        </div>
        <div className="rounded-lg p-4" style={{ background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)" }}>
          <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>🔕 Privacy boundary</div>
          <p className="mt-2 text-xs leading-5" style={{ color: "var(--text-muted)" }}>{privacyNote}</p>
        </div>
      </div>

      <div className="mb-6 rounded-lg p-4" style={{ background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)" }}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Device notifications</div>
            <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
              Local notifications work while Ohiyo is open. Server-backed PWA push needs a VAPID key on the relay.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={enableLocalNotifications} className="rounded-full px-3 py-2 text-xs font-semibold" style={{ background: "var(--bg-input)", color: "var(--text-secondary)" }}>
              Enable local notifications
            </button>
            <button type="button" onClick={enablePush} disabled={!canUseWebPush() || !serverPushEnabled || busy} className="rounded-full px-3 py-2 text-xs font-semibold" style={{ background: "var(--accent)", color: "white", opacity: canUseWebPush() && serverPushEnabled && !busy ? 1 : 0.55 }}>
              {busy ? "Enabling…" : "Enable content-free PWA push"}
            </button>
          </div>
        </div>
        {!serverPushEnabled && (
          <p className="mt-3 rounded-lg px-3 py-2 text-xs" style={{ background: "var(--bg-input)", color: "var(--text-muted)" }}>
            Server-backed PWA push is not configured on this home yet. Set <code>OHIYO_WEB_PUSH_PUBLIC_KEY</code> and the dispatcher credentials to enable it; APNs/FCM native setup is documented for mobile builds.
          </p>
        )}
      </div>

      <div className="rounded-lg p-4" style={{ background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)" }}>
        <div className="mb-3 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>Registered push devices</div>
        {devices.length === 0 ? (
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>No server-backed push devices registered yet.</p>
        ) : (
          <div className="grid gap-2">
            {devices.map((d) => (
              <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-3 py-2" style={{ background: "var(--bg-input)" }}>
                <div className="min-w-0">
                  <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>{d.device_name || d.platform}</div>
                  <div className="truncate text-[11px]" style={{ color: "var(--text-muted)", maxWidth: 420 }}>{d.platform} · {d.endpoint}</div>
                </div>
                <button type="button" onClick={() => void remove(d.id)} className="rounded-full px-3 py-1 text-xs font-semibold" style={{ background: "var(--bg-hover)", color: "var(--danger)" }}>Remove</button>
              </div>
            ))}
          </div>
        )}
      </div>
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
  privacyPrefs,
  onPrivacyPrefsChange,
}: {
  token: string;
  onToast: (t: string, type?: "info" | "success" | "error") => void;
  privacyPrefs: PrivacyPrefs;
  onPrivacyPrefsChange: (prefs: PrivacyPrefs) => void | Promise<void>;
}) {
  const [seconds, setSeconds] = useState<number | null>(null);
  const [scope, setScope] = useState<"history" | "keys">("history");
  const [confirmBurn, setConfirmBurn] = useState(false);
  // Backup & recovery (recovery-code model).
  const [hasBackup, setHasBackup] = useState<boolean | null>(null);
  const [backupInfo, setBackupInfo] = useState<BackupSummary | null>(null);
  const [newCode, setNewCode] = useState<string | null>(null);
  const [restoreInput, setRestoreInput] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);

  useEffect(() => {
    api
      .getDeadman(token)
      .then((c) => {
        setSeconds(c.seconds ?? null);
        setScope(c.scope === "keys" ? "keys" : "history");
      })
      .catch((e) => console.warn("[kikkacord] couldn't load deadman config", e));
  }, [token]);

  useEffect(() => {
    api
      .getKeyBackup(token)
      .then((blob) => {
        setHasBackup(true);
        setBackupInfo(backupSummary(blob));
      })
      .catch(() => {
        setHasBackup(false);
        setBackupInfo(null);
      }); // 404 = no backup yet
  }, [token]);

  async function createBackup() {
    setBackupBusy(true);
    try {
      const code = generateRecoveryCode();
      const material = exportKeyMaterial();
      const blob = await encryptBackup(code, material);
      await api.putKeyBackup(token, blob as unknown as Record<string, unknown>);
      setNewCode(code);
      setHasBackup(true);
      setBackupInfo(backupSummary(blob));
    } catch {
      onToast("Couldn't create backup", "error");
    } finally {
      setBackupBusy(false);
    }
  }

  async function restoreBackup() {
    if (!restoreInput.trim()) return;
    setBackupBusy(true);
    try {
      const blob = (await api.getKeyBackup(token)) as unknown as BackupBlob;
      const material = await decryptBackup(restoreInput, blob);
      await importKeyMaterial(material);
      sessionStorage.setItem("ohiyo:recovery-restored-at", String(Date.now()));
      onToast("Keys restored — reloading…", "success");
      setTimeout(() => window.location.reload(), 1200);
    } catch {
      onToast("That code didn't match the backup", "error");
      setBackupBusy(false);
    }
  }

  async function deleteBackup() {
    try {
      await api.deleteKeyBackup(token);
      setHasBackup(false);
      setBackupInfo(null);
      setNewCode(null);
      onToast("Backup deleted", "success");
    } catch {
      onToast("Couldn't delete backup", "error");
    }
  }

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

      {/* Linked devices — see + revoke your registered Signal devices */}
      <LinkedDevices token={token} onToast={onToast} />

      {/* Privacy Mode — immediate metadata reduction without changing how chat works. */}
      <div className="mb-6 rounded-lg p-4" style={{ background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)" }}>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
              🥷 Privacy Mode
            </div>
            <p className="mt-1 max-w-2xl text-xs" style={{ color: "var(--text-muted)" }}>
              Hide live behavioral metadata while keeping Ohiyo easy: no typing pings, no visible online/idle/activity,
              and no peer-visible “Seen” receipts. Messages, unread badges, and calls still work — joining a voice room
              still reveals you to that room.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={privacyPrefs.metadataMode}
            onClick={() => void onPrivacyPrefsChange({ ...privacyPrefs, metadataMode: !privacyPrefs.metadataMode })}
            className="kc-interactive rounded-full px-4 py-2 text-sm font-bold"
            style={{
              background: privacyPrefs.metadataMode ? "var(--accent)" : "var(--bg-input)",
              color: privacyPrefs.metadataMode ? "#fff" : "var(--text-secondary)",
              border: `1px solid ${privacyPrefs.metadataMode ? "var(--accent)" : "var(--bg-hover)"}`,
            }}
          >
            {privacyPrefs.metadataMode ? "On" : "Off"}
          </button>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {[
            ["No typing leaks", "Ohiyo stops telling rooms when you are composing."],
            ["Invisible presence", "Others will not get online/idle/activity updates for you."],
            ["Quiet receipts", "Your reads still clear your unread count, but peers do not get Seen updates."],
            ["Device synced", "The preference is stored in your account prefs and follows new sessions."],
          ].map(([title, body]) => (
            <div key={title} className="rounded-md px-3 py-2" style={{ background: "var(--bg-input)", border: "1px solid var(--bg-hover)" }}>
              <div className="text-xs font-bold" style={{ color: "var(--text-primary)" }}>{title}</div>
              <div className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>{body}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Backup & recovery (recovery-code model).
          UX rule: protection first, caveats second. A wall of crypto warnings makes people
          skip backup entirely, which is strictly worse than an honest keys-only snapshot. */}
      <div className="mb-6 rounded-lg p-4" style={{ background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)" }}>
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
            🔑 Personal recovery
          </div>
          {backupInfo?.updated_at && (
            <span className="rounded-full px-2 py-1 text-[11px] font-bold" style={{ background: "var(--bg-input)", color: "var(--green)" }}>
              Last backup {new Date(backupInfo.updated_at * 1000).toLocaleDateString()}
            </span>
          )}
        </div>
        <p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
          Back up your encryption keys now so a recovery code can help this account read messages on a new device. Ohiyo can store the backup, but only your recovery code can open it.
        </p>

        {newCode ? (
          <div
            className="mb-3 rounded-md p-3"
            style={{ background: "color-mix(in oklch, var(--accent) 10%, transparent)", border: "1px solid var(--accent)" }}
          >
            <div className="mb-1 text-xs font-bold uppercase" style={{ color: "var(--accent)", letterSpacing: "0.04em" }}>
              Your recovery code
            </div>
            <code
              className="block font-mono text-sm tracking-wider"
              style={{ color: "var(--text-primary)", wordBreak: "break-all" }}
            >
              {newCode}
            </code>
            <p className="mt-2 text-xs" style={{ color: "var(--text-secondary)" }}>
              ⚠️ Write this down and keep it safe. It can restore your encryption identity and keys. Anyone with it may be able to restore this encrypted state; we can&apos;t reset it for you.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  navigator.clipboard.writeText(newCode).then(() => onToast("Recovery code copied", "success"));
                }}
                className="rounded px-3 py-1.5 text-xs font-semibold"
                style={{ background: "var(--accent)", color: "#fff" }}
              >
                Copy code
              </button>
              <button
                type="button"
                onClick={() => setNewCode(null)}
                className="kc-interactive rounded px-3 py-1.5 text-xs"
                style={{ color: "var(--text-secondary)", border: "1px solid var(--bg-hover)", background: "transparent" }}
              >
                I&apos;ve saved it
              </button>
            </div>
          </div>
        ) : (
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={createBackup}
              disabled={backupBusy}
              className="rounded px-3 py-1.5 text-sm font-semibold"
              style={{ background: "var(--accent)", color: "#fff", opacity: backupBusy ? 0.6 : 1 }}
            >
              {hasBackup ? "Back up keys again" : "Back up my keys now"}
            </button>
            {hasBackup && (
              <>
                <span className="text-xs" style={{ color: "var(--green)" }}>✓ Keys-only snapshot saved{backupInfo?.entry_count ? ` · ${backupInfo.entry_count} entries` : ""}</span>
                <button
                  type="button"
                  onClick={deleteBackup}
                  className="kc-interactive rounded px-2 py-1 text-xs"
                  style={{ color: "var(--danger)", background: "transparent", border: "1px solid var(--bg-hover)" }}
                >
                  Delete backup
                </button>
              </>
            )}
          </div>
        )}

        <details className="mb-3 rounded-md p-3 text-xs" style={{ background: "var(--bg-input)", color: "var(--text-muted)", border: "1px solid var(--bg-hover)" }}>
          <summary className="cursor-pointer font-semibold" style={{ color: "var(--text-primary)" }}>What this protects</summary>
          <div className="mt-2 grid gap-1.5">
            <p>This is a <strong>keys-only snapshot</strong>: it protects key material present when you press the button. Run it again after important activity until continuous backup ships.</p>
            <p>Ohiyo does not include your decrypted plaintext cache by default. That stronger history recovery mode would store user-encrypted plaintext on the server and needs an explicit advanced opt-in.</p>
            <p>Backup coverage handles are blinded with your recovery secret. The server stores opaque handles, not clear room ids or per-room activity timestamps.</p>
          </div>
        </details>

        {/* Restore */}
        <div className="border-t pt-3" style={{ borderColor: "var(--bg-hover)" }}>
          <div className="mb-1.5 text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
            Restore on this device
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              value={restoreInput}
              onChange={(e) => setRestoreInput(e.target.value)}
              placeholder="Paste your recovery code"
              aria-label="Recovery code"
              className="flex-1 rounded px-3 py-2 text-sm outline-none font-mono"
              style={{ background: "var(--bg-input)", color: "var(--text-primary)", minWidth: 220 }}
            />
            <button
              type="button"
              onClick={restoreBackup}
              disabled={backupBusy || !restoreInput.trim()}
              className="kc-interactive rounded px-3 py-2 text-sm font-semibold"
              style={{
                border: "1px solid var(--accent)",
                color: "var(--accent)",
                background: "transparent",
                opacity: backupBusy || !restoreInput.trim() ? 0.6 : 1,
              }}
            >
              Restore
            </button>
          </div>
        </div>
      </div>

      {/* Dead man's switch */}
      <div className="mb-6 rounded-lg p-4" style={{ background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)" }}>
        <div className="mb-1 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          ⏳ Dead man&apos;s switch
        </div>
        <p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
          If you don&apos;t open Ohiyo for this long, your data is wiped automatically.
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
