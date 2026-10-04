import { useState } from "react";
import type { PluginManager } from "../../plugins/registry";
import type { OhiyoPlugin } from "../../plugins/api";
import { isDesktop } from "../../lib/desktop";

type Props = {
  pluginManager: PluginManager;
  onToast: (text: string, type?: "info" | "success" | "error") => void;
};

type RowProps = {
  plugin: OhiyoPlugin;
  isOn: boolean;
  onToggle: () => void;
  /** Set for plugins the user added: shows who made it and a way to remove it. */
  onRemove?: () => void;
};

function PluginRow({ plugin, isOn, onToggle, onRemove }: RowProps) {
  return (
    <li className="flex items-center gap-4 rounded-lg p-4" style={{ background: "var(--bg-sidebar)" }}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          {plugin.name}
          {onRemove && plugin.author && (
            <span className="ml-2 text-xs font-normal" style={{ color: "var(--text-muted)" }}>
              by {plugin.author}
            </span>
          )}
        </div>
        <div className="mt-0.5 text-xs" style={{ color: "var(--text-secondary)" }}>
          {plugin.description}
        </div>
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${plugin.name}`}
          className="kc-interactive flex-shrink-0 rounded px-2 py-1 text-xs font-semibold"
          style={{ background: "var(--bg-hover)", color: "var(--danger)" }}
        >
          Remove
        </button>
      )}
      <button type="button" role="switch" aria-checked={isOn} aria-label={plugin.name} onClick={onToggle} className="kc-switch">
        <span className="kc-switch__knob" />
      </button>
    </li>
  );
}

export function PluginsTab({ pluginManager, onToast }: Props) {
  const [enabled, setEnabled] = useState<string[]>(() => pluginManager.enabledIds());
  const [plugins, setPlugins] = useState<OhiyoPlugin[]>(() => [...pluginManager.allPlugins()]);
  const [link, setLink] = useState("");
  const [isAdding, setIsAdding] = useState(false);

  // The web app's security policy only lets it download from its own site, so a link to a
  // plugin on another site can never load there. The desktop app (and a dev server) can.
  const canAddFromLink = isDesktop() || !import.meta.env.PROD;

  function toggle(plugin: OhiyoPlugin) {
    if (enabled.includes(plugin.id)) {
      pluginManager.disable(plugin.id);
      onToast(`${plugin.name} is off`, "info");
    } else {
      pluginManager.enable(plugin.id);
      onToast(`${plugin.name} is on`, "success");
    }
    setEnabled(pluginManager.enabledIds());
  }

  async function addFromLink() {
    const url = link.trim();
    if (!url || isAdding) return;
    setIsAdding(true);
    try {
      const id = await pluginManager.installFromUrl(url);
      pluginManager.enable(id);
      const added = pluginManager.allPlugins().find((p) => p.id === id);
      setPlugins([...pluginManager.allPlugins()]);
      setEnabled(pluginManager.enabledIds());
      setLink("");
      onToast(`${added?.name ?? "Plugin"} added and switched on`, "success");
    } catch (err) {
      onToast(err instanceof Error ? err.message : "Couldn't add that plugin.", "error");
    } finally {
      setIsAdding(false);
    }
  }

  function remove(plugin: OhiyoPlugin) {
    pluginManager.uninstallUserPlugin(plugin.id);
    setPlugins([...pluginManager.allPlugins()]);
    setEnabled(pluginManager.enabledIds());
    onToast(`${plugin.name} removed`, "info");
  }

  const ours = plugins.filter((p) => !pluginManager.isUserPlugin(p.id));
  const theirs = plugins.filter((p) => pluginManager.isUserPlugin(p.id));
  const sectionLabel = "mb-2 text-xs font-bold uppercase tracking-wide";

  return (
    <div>
      <h2 className="mb-1 text-xl font-bold">Plugins</h2>
      <p className="mb-6 text-sm" style={{ color: "var(--text-muted)" }}>
        Small extras you can switch on or off. They only change Ohiyo on this device.
      </p>

      <section className="mb-6" aria-labelledby="kc-plugins-ours">
        <h3 id="kc-plugins-ours" className={sectionLabel} style={{ color: "var(--text-muted)" }}>
          Made by Ohiyo
        </h3>
        <ul className="flex flex-col gap-2">
          {ours.map((p) => (
            <PluginRow key={p.id} plugin={p} isOn={enabled.includes(p.id)} onToggle={() => toggle(p)} />
          ))}
        </ul>
      </section>

      {theirs.length > 0 && (
        <section className="mb-6" aria-labelledby="kc-plugins-theirs">
          <h3 id="kc-plugins-theirs" className={sectionLabel} style={{ color: "var(--text-muted)" }}>
            Added by you
          </h3>
          <ul className="flex flex-col gap-2">
            {theirs.map((p) => (
              <PluginRow
                key={p.id}
                plugin={p}
                isOn={enabled.includes(p.id)}
                onToggle={() => toggle(p)}
                onRemove={() => remove(p)}
              />
            ))}
          </ul>
        </section>
      )}

      <details className="kc-plugins-add rounded-lg" style={{ background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)" }}>
        <summary className="cursor-pointer px-4 py-3 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Add a plugin from a link
        </summary>
        <div className="px-4 pb-4">
          <p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
            This is for plugins other people have written. A plugin like that can read messages as they arrive
            (but not the ones in end-to-end encrypted chats). It can't use the internet or touch your account.
            Ohiyo downloads it again from its link every time the app opens, so only add links you trust.
          </p>
          {canAddFromLink ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void addFromLink();
              }}
            >
              <input
                value={link}
                onChange={(e) => setLink(e.target.value)}
                aria-label="Link to a plugin"
                placeholder="https://example.com/my-plugin.js"
                className="kc-field min-w-0 flex-1 px-3 py-2 font-mono text-sm outline-none"
              />
              <button type="submit" disabled={isAdding || !link.trim()} className="kc-cta px-3 py-2 text-sm disabled:opacity-50">
                {isAdding ? "Adding…" : "Add"}
              </button>
            </form>
          ) : (
            <p className="text-xs font-semibold" style={{ color: "var(--text-secondary)" }}>
              Adding a plugin from a link only works in the Ohiyo desktop app. A browser won't let Ohiyo download
              code from other sites.
            </p>
          )}
        </div>
      </details>
    </div>
  );
}
