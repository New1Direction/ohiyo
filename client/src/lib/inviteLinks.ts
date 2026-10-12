// What a pasted or opened Ohiyo link points at: a space invite or a one-time private DM link.
// One reader for the welcome screen's link box, the "+" button's join box and desktop deep links.
export type SharedLink = { kind: "invite"; code: string } | { kind: "dm"; token: string };

// Invite codes are server-made tokens. Keep to a conservative, URL-safe shape so a hostile link
// can't smuggle anything else downstream (path tricks, query injection, oversized values).
const CODE_RE = /^[A-Za-z0-9_-]{1,64}$/;
// A bare value counts as a code only when it's long enough not to be an ordinary word.
const BARE_CODE_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DESKTOP_SCHEMES = new Set(["ohiyo:", "kikkacord:"]);

/** Read a bare invite code, an app link (`?invite=`, `/invite/<code>`, `?dm=`, `/dm/<token>`)
 *  or a desktop `ohiyo://invite/<code>` link. Anything else is `null`. */
export function parseSharedLink(raw: string, base = "https://app.ohiyo.gg"): SharedLink | null {
  const value = raw.trim();
  if (!value) return null;
  if (BARE_CODE_RE.test(value)) return { kind: "invite", code: value };

  let url: URL;
  try {
    url = new URL(value, base);
  } catch {
    return null;
  }

  if (DESKTOP_SCHEMES.has(url.protocol)) {
    // ohiyo://invite/CODE → hostname "invite", path "/CODE"; ohiyo://CODE → hostname "CODE".
    const path = url.pathname.replace(/^\/+/, "");
    const code = url.hostname === "invite" ? path : url.hostname || path;
    return CODE_RE.test(code) ? { kind: "invite", code } : null;
  }

  const invite = url.searchParams.get("invite") ?? url.pathname.match(/\/invite\/([^/?#]+)/)?.[1] ?? null;
  if (invite !== null) return CODE_RE.test(invite) ? { kind: "invite", code: invite } : null;

  const dm = url.searchParams.get("dm") ?? url.pathname.match(/\/dm\/([^/?#]+)/)?.[1] ?? null;
  return dm ? { kind: "dm", token: dm } : null;
}
