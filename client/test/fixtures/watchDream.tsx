import { useState } from "react";
import { createRoot } from "react-dom/client";
import { WatchParty } from "../../src/components/WatchParty";
import "../../src/index.css";

const session = { url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", paused: true, position: 48, updated_at: 1000, host_id: "host" };
function Fixture() {
  const [channel, setChannel] = useState("general");
  const [active, setActive] = useState(true);
  const [guest, setGuest] = useState(false);
  const [extra, setExtra] = useState(false);
  Object.assign(window, {
    dreamFixture: {
      navigate: () => setChannel("another"),
      endRemotely: () => setActive(false),
      guest: () => setGuest(true),
      addSibling: () => setExtra(true),
      unmount: () => root.unmount(),
    },
  });
  return <div style={{ display: "flex", height: "100vh", overflow: "hidden", background: "var(--bg-channel)" }}>
    <aside style={{ width: 290, flexShrink: 0, background: "var(--bg-sidebar)", padding: 24 }}>
      <h1>Repoing</h1><p>Private space</p><button>Invite</button><p>TEXT CHANNELS</p><button># general</button><p>VOICE CHANNELS</p><button>Join voice</button>
    </aside>
    <main style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
      <header style={{ padding: 16 }}><button># {channel}</button></header>
      {active && <WatchParty key={channel} session={session} isHost={!guest} onControl={() => setActive(false)} />}
      <section style={{ flex: 1, padding: 24 }}><p>Kikka</p><p>This is such a good part.</p><button>React to message</button></section>
      {extra && <button id="new-sibling">New background control</button>}
      <footer style={{ padding: 16 }}><input aria-label="Message" placeholder="Say something to #general…" /></footer>
    </main>
  </div>;
}
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
