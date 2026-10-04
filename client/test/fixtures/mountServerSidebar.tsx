import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ServerSidebar } from "../../src/components/ServerSidebar";
import "../../src/index.css";
import { applyTheme, BUILTIN_THEMES } from "../../src/themes";
Object.assign(window, { setRailTheme: (id: string) => applyTheme(BUILTIN_THEMES.find(theme => theme.id === id)!) });

function Fixture() {
  const [activeHomeId, setActiveHomeId] = useState("official");
  const [lastAction, setLastAction] = useState("");
  return <div style={{ display: "flex", minHeight: "100vh", background: "var(--bg-base)" }}>
    <ServerSidebar servers={[]} selectedId="community" onSelect={() => setLastAction("dm")}
      onCreateServer={() => setLastAction("create")} onOpenSettings={() => setLastAction("settings")}
      onOpenSaved={() => setLastAction("saved")} activeHomeId={activeHomeId} onSwitchHome={setActiveHomeId}
      onAddHome={() => setLastAction("add-home")}
      homes={[
        { id: "official", name: "Ohiyo", url: "https://api.ohiyo.gg", token: null },
        { id: "custom", name: "Friends", url: "https://friends.example", token: null },
      ]} />
    <output aria-label="Last action">{lastAction}</output>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
