use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use crate::{auth::AuthUser, AppState};

/// True if `ip` is a public, routable address (i.e. NOT loopback/private/link-local/
/// unspecified/broadcast). Blocks cloud metadata at 169.254.169.254, localhost, and
/// internal services.
fn is_public_ip(ip: IpAddr) -> bool {
    // An IPv6 address that carries an IPv4 one reaches that IPv4 host: judge it as one.
    let ip = match ip {
        IpAddr::V6(v6) => embedded_ipv4(v6).map_or(ip, IpAddr::V4),
        v4 => v4,
    };
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, c, _] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation() // 192.0.2/24, 198.51.100/24, 203.0.113/24
                || a == 0
                || (a == 100 && (b & 0xc0) == 64) // shared address space 100.64.0.0/10
                || (a == 192 && b == 0 && c == 0) // IETF protocol assignments 192.0.0.0/24
                || (a == 198 && (b & 0xfe) == 18) // benchmarking 198.18.0.0/15
                || a >= 240) // reserved 240.0.0.0/4
        }
        IpAddr::V6(v6) => {
            let s = v6.segments();
            !(v6.is_loopback() || v6.is_unspecified() || v6.is_multicast()
                || (s[0] == 0x2001 && s[1] == 0) // Teredo 2001::/32
                || s[..4] == [0x100, 0, 0, 0] // discard 100::/64
                || s[..3] == [0x64, 0xff9b, 1] // local-use NAT64 64:ff9b:1::/48
                || (s[0] & 0xfe00) == 0xfc00 // unique-local fc00::/7
                || (s[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
                || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation 2001:db8::/32
                || (s[0] == 0x3fff && (s[1] & 0xf000) == 0)) // documentation 3fff::/20
        }
    }
}

/// The IPv4 address inside an IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96),
/// NAT64 (64:ff9b::/96) or 6to4 (2002::/16) IPv6 address.
fn embedded_ipv4(v6: Ipv6Addr) -> Option<Ipv4Addr> {
    if let Some(v4) = v6.to_ipv4_mapped() {
        return Some(v4);
    }
    let s = v6.segments();
    let o = v6.octets();
    if s[..6] == [0x64, 0xff9b, 0, 0, 0, 0] || s[..6] == [0, 0, 0, 0, 0, 0] {
        return Some(Ipv4Addr::new(o[12], o[13], o[14], o[15]));
    }
    if s[0] == 0x2002 {
        return Some(Ipv4Addr::new(o[2], o[3], o[4], o[5]));
    }
    None
}

/// Resolve `url`'s host and return `(host, port, validated_addrs)` ONLY if every
/// resolved address is public. Returns `None` if the URL is malformed, resolution
/// fails, or ANY resolved address is private/loopback/link-local — so an attacker
/// can't slip an internal IP into a multi-record DNS answer.
pub(crate) async fn resolve_public_addrs(url: &str) -> Option<(String, u16, Vec<SocketAddr>)> {
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

    fn public(ip: &str) -> bool {
        is_public_ip(ip.parse().unwrap())
    }

    #[test]
    fn ordinary_public_addresses_are_public() {
        for ip in [
            "8.8.8.8",
            "1.1.1.1",
            "100.63.255.255",
            "100.128.0.0",
            "198.20.0.1",
            // Just outside the documentation ranges.
            "192.0.3.0",
            "198.51.101.0",
            "203.0.114.0",
        ] {
            assert!(public(ip), "{ip}");
        }
        for ip in [
            "2606:4700:4700::1111",
            "2a00:1450:4001::200e",
            "::ffff:8.8.8.8",
            // NAT64 and 6to4 addresses embedding a public IPv4 address.
            "64:ff9b::8.8.8.8",
            "2002:808:808::1",
        ] {
            assert!(public(ip), "{ip}");
        }
    }

    #[test]
    fn ipv4_documentation_ranges_are_not_public() {
        for ip in [
            // TEST-NET-1, 192.0.2.0/24.
            "192.0.2.0",
            "192.0.2.255",
            // TEST-NET-2, 198.51.100.0/24.
            "198.51.100.0",
            "198.51.100.255",
            // TEST-NET-3, 203.0.113.0/24.
            "203.0.113.0",
            "203.0.113.255",
        ] {
            assert!(!public(ip), "{ip}");
        }
    }

    #[test]
    fn nat64_is_judged_by_its_embedded_ipv4_address() {
        // 64:ff9b::/96 carries the IPv4 address in its last 32 bits.
        for ip in [
            "64:ff9b::127.0.0.1",
            "64:ff9b::10.0.0.1",
            "64:ff9b::169.254.169.254",
            "64:ff9b::192.168.1.1",
            "64:ff9b::100.64.0.1",
        ] {
            assert!(!public(ip), "{ip}");
        }
    }

    #[test]
    fn six_to_four_is_judged_by_its_embedded_ipv4_address() {
        // 2002::/16 carries the IPv4 address in bits 16..48.
        for ip in [
            "2002:7f00:1::",      // 127.0.0.1
            "2002:a00:1::1",      // 10.0.0.1
            "2002:a9fe:a9fe::1",  // 169.254.169.254
            "2002:c0a8:101:1::1", // 192.168.1.1
            "2002:c000:201::1",   // 192.0.2.1, documentation
        ] {
            assert!(!public(ip), "{ip}");
        }
    }

    #[test]
    fn ipv4_compatible_is_judged_by_its_embedded_ipv4_address() {
        // ::/96 carries the IPv4 address in its last 32 bits.
        for ip in [
            "::127.0.0.1",
            "::10.0.0.1",
            "::169.254.169.254",
            "::192.168.1.1",
            "::100.64.0.1",
        ] {
            assert!(!public(ip), "{ip}");
        }
        assert!(public("::8.8.8.8"));
    }

    #[test]
    fn local_use_nat64_is_never_public() {
        // 64:ff9b:1::/48 is local-use, never a public site's address, whatever it embeds
        // and wherever (RFC 6052 allows several positions inside it).
        for ip in [
            "64:ff9b:1::127.0.0.1",
            "64:ff9b:1::10.0.0.1",
            "64:ff9b:1::169.254.169.254",
            "64:ff9b:1:ffff:ffff:ffff:192.168.1.1",
            "64:ff9b:1::8.8.8.8",
            "64:ff9b:1:ffff:ffff:ffff:8.8.8.8",
            // The /64 form of 10.0.0.8, whose last 32 bits read as 8.0.0.0.
            "64:ff9b:1:0:a:0:800:0",
        ] {
            assert!(!public(ip), "{ip}");
        }
        // The well-known prefix is still judged by its embedded address.
        assert!(public("64:ff9b::8.8.8.8"));
    }

    #[test]
    fn teredo_is_not_public() {
        // 2001::/32, whatever it embeds.
        for ip in [
            "2001::",
            "2001::1",
            "2001:0:4136:e378:8000:63bf:3fff:fdd2",
            "2001:0:ffff:ffff:ffff:ffff:ffff:ffff",
        ] {
            assert!(!public(ip), "{ip}");
        }
        assert!(public("2001:4860:4860::8888"), "outside 2001::/32");
    }

    #[test]
    fn the_discard_prefix_is_not_public() {
        // 100::/64.
        for ip in ["100::", "100::1", "100::ffff:ffff:ffff:ffff"] {
            assert!(!public(ip), "{ip}");
        }
    }

    #[test]
    fn ipv4_mapped_ipv6_is_judged_as_the_ipv4_address() {
        for ip in [
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
            "::ffff:169.254.169.254",
            "::ffff:192.168.1.1",
            "::ffff:100.64.0.1",
        ] {
            assert!(!public(ip), "{ip}");
        }
    }

    #[test]
    fn reserved_ipv4_ranges_are_not_public() {
        for ip in [
            // Already blocked: loopback, private, link-local, unspecified, broadcast, 0/8.
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.0.1",
            "169.254.169.254",
            "0.0.0.0",
            "255.255.255.255",
            // Shared address space (carrier-grade NAT), 100.64.0.0/10.
            "100.64.0.0",
            "100.127.255.255",
            // IETF protocol assignments, 192.0.0.0/24.
            "192.0.0.0",
            "192.0.0.255",
            // Benchmarking, 198.18.0.0/15.
            "198.18.0.0",
            "198.19.255.255",
            // Reserved, 240.0.0.0/4.
            "240.0.0.1",
            "254.255.255.255",
            // Multicast, 224.0.0.0/4.
            "224.0.0.1",
            "239.255.255.255",
        ] {
            assert!(!public(ip), "{ip}");
        }
    }

    #[test]
    fn reserved_ipv6_ranges_are_not_public() {
        for ip in [
            "::1",
            "::",
            // Unique local, fc00::/7.
            "fc00::1",
            "fdff:ffff::1",
            // Link-local, fe80::/10.
            "fe80::1",
            "febf::1",
            // Multicast, ff00::/8.
            "ff02::1",
            "ff0e::1",
            // Documentation, 2001:db8::/32 and 3fff::/20.
            "2001:db8::1",
            "2001:db8:ffff::1",
            "3fff::1",
            "3fff:0fff::1",
        ] {
            assert!(!public(ip), "{ip}");
        }
    }

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
