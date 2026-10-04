import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { WatchParty } from "../../src/components/WatchParty";
export { act };
const session = { url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", paused: true, position: 48, updated_at: 1000, host_id: "host" };
export function mountWatchDream(container: HTMLElement) {
  const root = createRoot(container);
  const render = (key = "general", active = true, isHost = true, onControl = () => {}) => act(() => root.render(
    <div><aside><button>Invite</button></aside><main><header>Channel</header>
      {active && <WatchParty key={key} session={session} isHost={isHost} onControl={onControl} />}
      <section>Messages</section><footer><input aria-label="Message" /></footer>
    </main></div>,
  ));
  return { render, unmount: () => act(() => root.unmount()) };
}
