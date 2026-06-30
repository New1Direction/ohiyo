use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr};

use crate::{auth::AuthUser, AppState};

/// True if `ip` is a public, routable address (i.e. NOT loopback/private/link-local/
/// unspecified/broadcast). Blocks cloud metadata at 169.254.169.254, localhost, and
/// internal services.
fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.octets()[0] == 0)
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            !(v6.is_loopback() || v6.is_unspecified()
                || (s[0] & 0xfe00) == 0xfc00 // unique-local fc00::/7
                || (s[0] & 0xffc0) == 0xfe80) // link-local fe80::/10
        }
    }
}

/// Resolve `url`'s host and return `(host, port, validated_addrs)` ONLY if every
/// resolved address is public. Returns `None` if the URL is malformed, resolution
/// fails, or ANY resolved address is private/loopback/link-local — so an attacker
/// can't slip an internal IP into a multi-record DNS answer.
async fn resolve_public_addrs(url: &str) -> Option<(String, u16, Vec<SocketAddr>)> {
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_owned();
    let port = parsed.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .ok()?
        .collect();
    if addrs.is_empty() || !addrs.iter().all(|sa| is_public_ip(sa.ip())) {
        return None;
    }
    Some((host, port, addrs))
}

/// SSRF guard — reject URLs whose host resolves to a private/loopback/link-local
/// address. Used by callers that only need a yes/no answer (e.g. the watch-party
/// URL guard); the link-preview fetcher uses `resolve_public_addrs` so it can pin
/// the connection to the exact IP it validated (closes the DNS-rebinding window).
pub(crate) async fn is_public_url(url: &str) -> bool {
    resolve_public_addrs(url).await.is_some()
}

#[derive(Deserialize)]
pub struct OgQuery {
    pub url: String,
}

#[derive(Serialize, Default)]
pub struct OgData {
    pub url: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    pub site_name: Option<String>,
    pub favicon: Option<String>,
}

static HTTP: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();

const HTTP_TIMEOUT_SECS: u64 = 5;
const HTTP_USER_AGENT: &str = "Ohiyo/1.0 (link preview bot)";

/// Shared client for the specialised handlers (YouTube oEmbed, GitHub API) that hit
/// fixed, trusted hosts. The generic page fetcher does NOT use this — it pins each
/// request to a validated IP via `pinned_client` (see `fetch_guarded`).
fn http() -> &'static reqwest::Client {
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
            .user_agent(HTTP_USER_AGENT)
            // No auto-redirects: we follow manually so EVERY hop is SSRF-checked
            // (a public URL must not be able to bounce us to an internal address).
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("http client")
    })
}

/// Build a one-off client that forces `host` to resolve ONLY to `addr` — the exact
/// address we already validated as public. This pins the TCP connect to the checked
/// IP, eliminating the check-then-connect TOCTOU / DNS-rebinding window (between our
/// `lookup_host` and reqwest's own resolution, a hostile resolver could otherwise
/// return an internal IP).
fn pinned_client(host: &str, addr: SocketAddr) -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
        .user_agent(HTTP_USER_AGENT)
        .redirect(reqwest::redirect::Policy::none())
        .resolve_to_addrs(host, &[addr])
        .build()
        .ok()
}

/// Max bytes buffered from a previewed page — bounds memory on large/hostile pages.
const MAX_BODY_BYTES: usize = 512 * 1024;
/// Max redirect hops, each re-validated against the SSRF guard.
const MAX_REDIRECTS: usize = 5;

/// GET `url`, manually following up to `MAX_REDIRECTS` redirects. On every hop we
/// resolve the host, validate that ALL resolved addresses are public, then pin the
/// request to one validated address so the connection lands on the IP we checked
/// (not a rebound internal one). Returns the final non-redirect response, or `None`
/// if a hop is disallowed / the chain is too long / a request fails.
async fn fetch_guarded(url: &str) -> Option<reqwest::Response> {
    let mut current = url.to_owned();
    for _ in 0..=MAX_REDIRECTS {
        // Resolve + validate every IP, and capture the validated set so we connect to
        // the same address we checked (check and connect share one resolution result).
        let (host, _port, addrs) = resolve_public_addrs(&current).await?;
        let addr = *addrs.first()?;
        let client = pinned_client(&host, addr)?;
        let resp = client.get(&current).send().await.ok()?;
        if resp.status().is_redirection() {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())?;
            // Resolve relative redirects against the current URL before re-checking.
            current = url::Url::parse(&current).ok()?.join(loc).ok()?.to_string();
            continue;
        }
        return Some(resp);
    }
    None
}

/// Read at most `MAX_BODY_BYTES` of a response body as a lossy UTF-8 string.
async fn read_capped(mut resp: reqwest::Response) -> Option<String> {
    let mut buf: Vec<u8> = Vec::new();
    loop {
        match resp.chunk().await {
            Ok(Some(chunk)) => {
                buf.extend_from_slice(&chunk);
                if buf.len() >= MAX_BODY_BYTES {
                    buf.truncate(MAX_BODY_BYTES);
                    break;
                }
            }
            Ok(None) => break,
            Err(_) => return None,
        }
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

pub async fn fetch_og(
    auth: AuthUser,
    State(state): State<AppState>,
    Query(q): Query<OgQuery>,
) -> Result<Json<OgData>, (StatusCode, String)> {
    // Authenticated + rate-limited so link previews can't be a free SSRF/proxy oracle.
    if !state.rate.check(
        &format!("og:{}", auth.0),
        20,
        std::time::Duration::from_secs(60),
    ) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "too many link previews".into(),
        ));
    }
    let url = q.url.trim().to_owned();
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return Err((
            StatusCode::BAD_REQUEST,
            "only http/https URLs are supported".into(),
        ));
    }

    match fetch_og_data(&url).await {
        Some(og) => Ok(Json(og)),
        None => Err((
            StatusCode::BAD_GATEWAY,
            "couldn't fetch link preview".into(),
        )),
    }
}

pub(crate) fn is_youtube_url(url: &str) -> bool {
    let Ok(parsed) = url::Url::parse(url) else {
        return false;
    };
    let Some(host) = parsed
        .host_str()
        .map(|h| h.trim_start_matches("www.").trim_start_matches("m."))
    else {
        return false;
    };
    (host == "youtu.be" && parsed.path_segments().and_then(|mut s| s.next()).is_some())
        || ((host == "youtube.com" || host.ends_with(".youtube.com"))
            && (parsed.path() == "/watch"
                || parsed.path().starts_with("/shorts/")
                || parsed.path().starts_with("/embed/")
                || parsed.path().starts_with("/live/")))
}

/// Resolve Open Graph data for a single already-trimmed http(s) URL.
///
/// Self-contained: applies the SSRF guard and the specialised YouTube/GitHub
/// handlers, falling back to generic `<meta>` parsing. Returns `None` for
/// disallowed URLs or any fetch/parse failure. Has no auth/rate-limit of its
/// own — callers (the `/og` endpoint, the embed builder) gate it.
pub(crate) async fn fetch_og_data(url: &str) -> Option<OgData> {
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return None;
    }
    if !is_public_url(url).await {
        return None;
    }

    // ── Specialised handlers for sites that block generic scrapers ────────────

    // YouTube / youtu.be / Shorts / Live / Embed → use oEmbed API.
    if is_youtube_url(url) {
        let oembed_url = format!(
            "https://www.youtube.com/oembed?url={}&format=json",
            urlencoding::encode(url)
        );
        if let Ok(res) = http().get(&oembed_url).send().await {
            if let Ok(data) = res.json::<serde_json::Value>().await {
                return Some(OgData {
                    url: url.to_owned(),
                    title: data["title"].as_str().map(str::to_owned),
                    description: data["author_name"].as_str().map(|a| format!("by {a}")),
                    image: data["thumbnail_url"].as_str().map(str::to_owned),
                    site_name: Some("YouTube".into()),
                    favicon: Some("https://www.youtube.com/favicon.ico".into()),
                });
            }
        }
    }

    // GitHub repos → use GitHub public API (no auth for public repos)
    if let Some(path) = url.strip_prefix("https://github.com/") {
        let parts: Vec<&str> = path.trim_end_matches('/').splitn(3, '/').collect();
        if parts.len() >= 2 && !parts[1].is_empty() {
            let api_url = format!("https://api.github.com/repos/{}/{}", parts[0], parts[1]);
            if let Ok(res) = http()
                .get(&api_url)
                .header("Accept", "application/vnd.github+json")
                .header("X-GitHub-Api-Version", "2022-11-28")
                .send()
                .await
            {
                if let Ok(data) = res.json::<serde_json::Value>().await {
                    let stars = data["stargazers_count"].as_u64().unwrap_or(0);
                    let lang = data["language"].as_str().unwrap_or("");
                    let desc = data["description"].as_str().unwrap_or("").to_owned();
                    let full = data["full_name"].as_str().unwrap_or("").to_owned();
                    return Some(OgData {
                        url: url.to_owned(),
                        title: Some(full),
                        description: Some(format!("{desc} · ⭐ {stars} · {lang}")),
                        image: Some(format!(
                            "https://opengraph.githubassets.com/1/{}/{}",
                            parts[0], parts[1]
                        )),
                        site_name: Some("GitHub".into()),
                        favicon: Some("https://github.com/favicon.ico".into()),
                    });
                }
            }
        }
    }

    let response = fetch_guarded(url).await?;

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_owned();

    if !content_type.contains("text/html") {
        // Not HTML — return bare URL info (still useful for images/video)
        return Some(OgData {
            url: url.to_owned(),
            ..Default::default()
        });
    }

    // Cap the body so a hostile/huge page can't OOM the (spawned, unbounded) task.
    let html = read_capped(response).await?;

    // Parse OG tags with a lightweight regex-free parser.
    Some(parse_og(url, &html))
}

/// Resolve a meta image URL against the page URL and accept only http(s) — blocks
/// `javascript:`/`data:` schemes from third-party Open Graph tags (stored-XSS source).
fn safe_image_url(base: &str, candidate: &str) -> Option<String> {
    let resolved = url::Url::parse(base).ok()?.join(candidate.trim()).ok()?;
    matches!(resolved.scheme(), "http" | "https").then(|| resolved.to_string())
}

fn parse_og(url: &str, html: &str) -> OgData {
    let mut data = OgData {
        url: url.to_owned(),
        ..Default::default()
    };

    // Extract <meta> tags — only scan the first 8KB for perf. Back off to a char
    // boundary so a multi-byte codepoint straddling the cutoff can't panic the slice.
    let mut cut = html.len().min(8192);
    while !html.is_char_boundary(cut) {
        cut -= 1;
    }
    let scan = &html[..cut];

    for line in scan.split('<') {
        let lower = line.to_ascii_lowercase();
        if !lower.starts_with("meta ") {
            continue;
        }

        let prop = extract_attr(line, "property").or_else(|| extract_attr(line, "name"));
        let content = extract_attr(line, "content");

        if let (Some(prop), Some(content)) = (prop, content) {
            match prop.to_lowercase().as_str() {
                "og:title" | "twitter:title" => data.title.get_or_insert(content.clone()),
                "og:description" | "twitter:description" | "description" => {
                    data.description.get_or_insert(content.clone())
                }
                "og:image" | "twitter:image" => {
                    if data.image.is_none() {
                        data.image = safe_image_url(url, &content);
                    }
                    continue;
                }
                "og:site_name" => data.site_name.get_or_insert(content.clone()),
                _ => continue,
            };
        }
    }

    // Fallback title from <title> tag
    if data.title.is_none() {
        if let Some(start) = scan.find("<title") {
            if let Some(end_open) = scan[start..].find('>') {
                let after = &scan[start + end_open + 1..];
                if let Some(end_close) = after.find("</title") {
                    let title = after[..end_close].trim();
                    if !title.is_empty() {
                        data.title = Some(title.to_owned());
                    }
                }
            }
        }
    }

    // Best-effort favicon
    if let Ok(parsed) = url::Url::parse(url) {
        let origin = format!("{}://{}", parsed.scheme(), parsed.host_str().unwrap_or(""));
        data.favicon = Some(format!("{}/favicon.ico", origin));
    }

    data
}

fn extract_attr(tag: &str, attr: &str) -> Option<String> {
    let search = format!("{}=", attr);
    let lower = tag.to_ascii_lowercase();
    let pos = lower.find(&search)?;
    let rest = &tag[pos + search.len()..];
    // The attribute value is wrapped in either single or double quotes; take
    // everything up to the matching closing quote.
    let inner = rest
        .strip_prefix('"')
        .and_then(|r| r.split_once('"'))
        .or_else(|| rest.strip_prefix('\'').and_then(|r| r.split_once('\'')))?;
    Some(inner.0.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_youtube_url_shapes() {
        assert!(is_youtube_url(
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        ));
        assert!(is_youtube_url("https://youtu.be/dQw4w9WgXcQ"));
        assert!(is_youtube_url("https://m.youtube.com/shorts/dQw4w9WgXcQ"));
        assert!(is_youtube_url("https://youtube.com/embed/dQw4w9WgXcQ"));
        assert!(is_youtube_url("https://youtube.com/live/dQw4w9WgXcQ"));
        assert!(!is_youtube_url("https://example.com/watch?v=dQw4w9WgXcQ"));
        assert!(!is_youtube_url("https://youtube.com/channel/abc"));
    }
}
