// What someone typed into "Add an Ohiyo home". An invite code once went in as a server address
// (`daa596fqrut8` became https://daa596fqrut8, the app switched to it and nothing could load),
// so an invite or private DM link is opened on the current home instead, a home has to look like
// a host, and it has to answer as an Ohiyo server before it is added.
import { normalizeHomeUrl } from "./homes.ts";
import { parseSharedLink, type SharedLink } from "./inviteLinks.ts";

export type HomeInput = { kind: "home"; url: string } | { kind: "link"; link: SharedLink } | { kind: "invalid" };

export function readHomeInput(raw: string): HomeInput {
  const value = raw.trim();
  if (!value) return { kind: "invalid" };
  // "localhost" alone reads as a bare code; it's the local server.
  const link = /^localhost$/i.test(value) ? null : parseSharedLink(value);
  if (link) return { kind: "link", link };
  let url: URL;
  try {
    url = new URL(normalizeHomeUrl(value));
  } catch {
    return { kind: "invalid" };
  }
  // A server address: http(s) to a name with a dot in it (example.com, an .onion, an IP) or
  // localhost. A single word after https:// is a typo or a code, not a server.
  const host = url.hostname.toLowerCase();
  if (!/^https?:$/.test(url.protocol) || (!host.includes(".") && host !== "localhost")) return { kind: "invalid" };
  return { kind: "home", url: url.origin };
}

/** True when `<url>/healthz` answers "ok" (what an Ohiyo server says) within the time allowed. */
export async function isOhiyoHome(url: string, fetchImpl: typeof fetch = fetch, timeoutMs = 5000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${url}/healthz`, { signal: controller.signal, cache: "no-store" });
    return res.ok && (await res.text()).trim() === "ok";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
