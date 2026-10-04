// Entry bundled by the plugins page tests: renders the Plugins settings tab to static HTML
// with react-dom/server, over the real list of built-in plugins.
import { renderToStaticMarkup } from "react-dom/server";
import { PluginsTab } from "../../src/components/settings/PluginsTab";
import { BUILTIN_PLUGINS, PluginManager } from "../../src/plugins/registry";
import type { OhiyoPlugin } from "../../src/plugins/api";

export { BUILTIN_PLUGINS, PluginManager };

export function renderPluginsTab(enabledIds: string[], userPlugins: OhiyoPlugin[] = []): string {
  const manager = {
    enabledIds: () => enabledIds,
    allPlugins: () => [...BUILTIN_PLUGINS, ...userPlugins],
    isUserPlugin: (id: string) => userPlugins.some((p) => p.id === id),
  };
  return renderToStaticMarkup(<PluginsTab pluginManager={manager as unknown as PluginManager} onToast={() => {}} />);
}
