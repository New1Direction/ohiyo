// Where a stored file URL points. The server stores uploads as "/files/<id>?s=…", relative to
// itself, and the app can be on another address (ohiyo.gg and the API), so a stored URL is
// read against the home's file server.

/** A stored file URL on the home at `base`. Only http(s) absolute URLs pass through as they
 *  are; anything else (data:, blob:) is read as a path on the home, so a crafted URL can't
 *  smuggle an inline payload into an <img> or a background. */
export function fileUrlOn(base: string, url: string): string {
  if (/^https?:/i.test(url)) return url;
  return `${base}${url.startsWith("/") ? url : `/${url}`}`;
}
