// What someone typed into "Add an Ohiyo home". (Stub: today's behaviour, every value is a home.)
import { normalizeHomeUrl } from "./homes.ts";
import type { SharedLink } from "./inviteLinks.ts";

export type HomeInput = { kind: "home"; url: string } | { kind: "link"; link: SharedLink } | { kind: "invalid" };

export function readHomeInput(raw: string): HomeInput {
  try {
    return { kind: "home", url: normalizeHomeUrl(raw) };
  } catch {
    return { kind: "invalid" };
  }
}

export async function isOhiyoHome(_url: string, _fetchImpl: typeof fetch = fetch, _timeoutMs = 5000): Promise<boolean> {
  return true;
}
