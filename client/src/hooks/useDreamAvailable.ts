import { useSyncExternalStore } from "react";
import { DREAM_MEDIA_QUERY, dreamAvailable } from "../lib/dreamAvailability";

const browserMatchMedia = () =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia.bind(window) : undefined;

function subscribe(onChange: () => void): () => void {
  const list = browserMatchMedia()?.(DREAM_MEDIA_QUERY);
  list?.addEventListener("change", onChange);
  return () => list?.removeEventListener("change", onChange);
}

/** Whether this screen can offer Dream mode; follows the window as it is resized. */
export function useDreamAvailable(): boolean {
  return useSyncExternalStore(subscribe, () => dreamAvailable(browserMatchMedia()), () => true);
}
