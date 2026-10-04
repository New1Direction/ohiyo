import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { DreamGestures } from "../../src/components/DreamGestures";
export { act };
export function mountDreamGestures(container: HTMLElement, onVolumeChange: (value: number) => void, onTogglePlayback: () => void) {
  const root = createRoot(container);
  const render = (volume: number | null = 35, isHost = true, disabledReason?: string) => act(() => root.render(
    <DreamGestures volume={volume} isHost={isHost} paused={false} onVolumeChange={onVolumeChange} onTogglePlayback={onTogglePlayback} disabledReason={disabledReason} />,
  ));
  return { render, unmount: () => act(() => root.unmount()) };
}
