/** URL scheme-validation helpers shared across the client.
 *
 *  These guard against `javascript:`/`data:`/`blob:` URLs reaching `href`/`src`,
 *  which would execute in the app origin (stored XSS) or enable open redirects. */

/**
 * Accept only http(s) URLs. Relative URLs resolve against the current origin,
 * so this also covers in-app links. Returns the normalised absolute URL, or
 * `undefined` when the input is empty, malformed, or uses a disallowed scheme
 * (e.g. `javascript:`, `data:`, `blob:`, `mailto:`).
 */
export function safeHttpUrl(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  try {
    const u = new URL(s, window.location.origin);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}
