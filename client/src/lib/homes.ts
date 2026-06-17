// Runtime Ohiyo homes: each home is one backend origin + its own session token.
// This is the client-side foundation for Instant Servers and self-host switching.

export type OhiyoHome = {
  id: string;
  name: string;
  url: string;
  token: string | null;
};

const HOMES_KEY = "kc:homes:v1";
const ACTIVE_KEY = "kc:active-home:v1";
const LEGACY_TOKEN_KEY = "token";

export const DEFAULT_HOME_URL = normalizeHomeUrl(
  (import.meta.env.VITE_SERVER_URL as string | undefined) ?? "http://localhost:3000"
);

export function normalizeHomeUrl(raw: string): string {
  let value = raw.trim();
  if (!value) return DEFAULT_HOME_URL;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  url.pathname = "";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function homeIdForUrl(url: string): string {
  return normalizeHomeUrl(url).replace(/^https?:\/\//, "").toLowerCase();
}

export function defaultHome(): OhiyoHome {
  return {
    id: homeIdForUrl(DEFAULT_HOME_URL),
    name: nameFromUrl(DEFAULT_HOME_URL),
    url: DEFAULT_HOME_URL,
    token: null,
  };
}

export function nameFromUrl(url: string): string {
  try {
    const host = new URL(normalizeHomeUrl(url)).host;
    if (host === "ohiyo.fly.dev") return "Ohiyo";
    if (host === "localhost:3000") return "Local";
    return host.replace(/^app\./, "").replace(/^api\./, "");
  } catch {
    return "Ohiyo";
  }
}

export function loadHomes(): OhiyoHome[] {
  let homes: OhiyoHome[] = [];
  try {
    const parsed = JSON.parse(localStorage.getItem(HOMES_KEY) || "[]") as Partial<OhiyoHome>[];
    homes = parsed
      .filter((h): h is OhiyoHome => Boolean(h?.id && h?.url))
      .map((h) => ({
        id: h.id,
        name: h.name || nameFromUrl(h.url),
        url: normalizeHomeUrl(h.url),
        token: h.token ?? null,
      }));
  } catch {
    homes = [];
  }

  const def = defaultHome();
  if (!homes.some((h) => h.id === def.id)) homes.unshift(def);

  // One-time migration from the original single-server token store.
  const legacyToken = localStorage.getItem(LEGACY_TOKEN_KEY);
  if (legacyToken) {
    homes = homes.map((h) => (h.id === def.id && !h.token ? { ...h, token: legacyToken } : h));
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  }

  saveHomes(homes);
  return homes;
}

export function saveHomes(homes: OhiyoHome[]) {
  localStorage.setItem(HOMES_KEY, JSON.stringify(dedupeHomes(homes)));
}

export function loadActiveHomeId(homes: OhiyoHome[]): string {
  const stored = localStorage.getItem(ACTIVE_KEY);
  if (stored && homes.some((h) => h.id === stored)) return stored;
  return homes[0]?.id ?? defaultHome().id;
}

export function saveActiveHomeId(id: string) {
  localStorage.setItem(ACTIVE_KEY, id);
}

export function upsertHome(homes: OhiyoHome[], input: { url: string; name?: string; token?: string | null }): OhiyoHome[] {
  const url = normalizeHomeUrl(input.url);
  const id = homeIdForUrl(url);
  const existing = homes.find((h) => h.id === id);
  const home: OhiyoHome = {
    id,
    url,
    name: input.name?.trim() || existing?.name || nameFromUrl(url),
    token: input.token ?? existing?.token ?? null,
  };
  return dedupeHomes([home, ...homes.filter((h) => h.id !== id)]);
}

export function setHomeToken(homes: OhiyoHome[], id: string, token: string | null): OhiyoHome[] {
  return homes.map((h) => (h.id === id ? { ...h, token } : h));
}

function dedupeHomes(homes: OhiyoHome[]): OhiyoHome[] {
  const seen = new Set<string>();
  const out: OhiyoHome[] = [];
  for (const h of homes) {
    const url = normalizeHomeUrl(h.url);
    const id = h.id || homeIdForUrl(url);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, url, name: h.name || nameFromUrl(url), token: h.token ?? null });
  }
  return out;
}
