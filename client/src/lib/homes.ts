// Runtime Ohiyo homes: each home is one backend origin + its own session token.
// This is the client-side foundation for Instant Servers and self-host switching.
//
// SESSION-TOKEN STORAGE (#12) — accepted tradeoff, documented deliberately:
//   The session token is stored in the `kc:homes:v1` localStorage blob below.
//   loadHomes() is SYNCHRONOUS and runs at component init, BEFORE the encrypted
//   desktop vault (tauriVault.initVaultBackend) has hydrated its in-memory mirror.
//   Moving the token into the vault would force loadHomes()/loadActiveHomeId() to
//   become async and ripple a sync→async refactor across every startup call site —
//   exactly the invasive change the brief warns against (and it would flash the user
//   as logged-out until the vault resolves). So:
//     • WEB build: no OS-backed secure store exists in a browser sandbox, so the token
//       stays in localStorage. This is the inherent, accepted web tradeoff.
//     • DESKTOP build: the `kc:tok:` prefix is registered in tauriVault's KEY_PREFIXES
//       (CONTRACT B / the vault_set allowlist), so standalone token keys under that
//       prefix are sealed-at-rest and included in encrypted recovery backups. The home
//       blob itself remains the synchronous source of truth to keep startup unbroken.
//   Net: no behavior change, no broken async, and the token namespace is vault-aware.

export type OhiyoHome = {
  id: string;
  name: string;
  url: string;
  token: string | null;
};

const HOMES_KEY = "kc:homes:v1";
const ACTIVE_KEY = "kc:active-home:v1";
const LEGACY_TOKEN_KEY = "token";
const TOKEN_PREFIX = "kc:tok:";

type KvStore = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
};

// Where per-home session tokens live — kept OUT of the plaintext `kc:homes:v1` blob.
// On DESKTOP, tauriVault points this at the encrypted locked-RAM vault via
// setHomesTokenStore() once it hydrates (sealed-at-rest); on WEB — no OS secure store in
// a browser sandbox — it stays localStorage (the inherent, accepted web tradeoff). The
// setter inversion (rather than importing the vault here) keeps homes a dependency-free
// leaf and mirrors setSignalBackend()/setSenderKeyBackend(). Before the desktop vault
// hydrates, reads miss and App.tsx waits on a vault-ready gate (then re-loads), so the
// token never has to sit in the plaintext blob just to survive startup.
let tokenBackend: KvStore | null = null;

export function setHomesTokenStore(store: KvStore | null): void {
  tokenBackend = store;
}

function tokenStore(): KvStore {
  return tokenBackend ?? localStorage;
}

function readToken(id: string): string | null {
  try {
    return tokenStore().getItem(TOKEN_PREFIX + id);
  } catch {
    return null;
  }
}

function writeToken(id: string, token: string | null): void {
  try {
    if (token) tokenStore().setItem(TOKEN_PREFIX + id, token);
    else tokenStore().removeItem(TOKEN_PREFIX + id);
  } catch {
    /* best-effort: a failed token persist just means re-login, never a crash */
  }
}
const FALLBACK_HOME_URL = "http://localhost:3000";
const ENV_HOME_URL = (import.meta as unknown as { env?: { VITE_SERVER_URL?: string } }).env
  ?.VITE_SERVER_URL;

export const DEFAULT_HOME_URL = normalizeHomeUrl(ENV_HOME_URL || FALLBACK_HOME_URL);

export function normalizeHomeUrl(raw: string): string {
  let value = raw.trim();
  if (!value) return FALLBACK_HOME_URL;
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
        // Tokens live in the secure per-home store. A non-null `h.token` here is a legacy
        // value left in the blob by an older build — prefer the store, fall back to it
        // (the trailing saveHomes() then migrates it into the store and strips the blob).
        token: readToken(h.id) ?? h.token ?? null,
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
  const deduped = dedupeHomes(homes);
  // Session tokens go to the secure per-home store (vault on desktop), never the
  // plaintext blob — the blob is persisted with every token nulled out.
  for (const h of deduped) writeToken(h.id, h.token);
  const blob = deduped.map((h) => ({ ...h, token: null }));
  localStorage.setItem(HOMES_KEY, JSON.stringify(blob));
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
