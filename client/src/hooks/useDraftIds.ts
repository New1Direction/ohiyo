import { useSyncExternalStore } from "react";
import { getDraftIds, subscribeDraftIds } from "../lib/drafts";

/** The chats with an unsent draft, for the sidebar's pencil; updates as drafts come and go. */
export function useDraftIds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeDraftIds, getDraftIds, getDraftIds);
}
