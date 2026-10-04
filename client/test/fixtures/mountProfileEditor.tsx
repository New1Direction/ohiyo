import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsModal } from "../../src/components/settings/SettingsModal";
import type { PluginManager } from "../../src/plugins/registry";
import { applyTheme, BUILTIN_THEMES } from "../../src/themes";
import "../../src/index.css";
Object.assign(window, { setProfileTheme: (id: string) => applyTheme(BUILTIN_THEMES.find(theme => theme.id === id)!) });
function Fixture() {
  const [toast, setToast] = useState("");
  const [open, setOpen] = useState(true);
  return <><button onClick={() => setOpen(true)}>Open profile</button>{open && <SettingsModal currentUser={null} pluginManager={{} as PluginManager} token="fixture" servers={[]} dms={[]} initialTab="profile" onClose={() => setOpen(false)} onToast={setToast} privacyPrefs={{ metadataMode: false }} onPrivacyPrefsChange={() => {}} />}<output aria-label="Save result" style={{ position: "fixed", zIndex: 10000, bottom: 0 }}>{toast}</output></>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
