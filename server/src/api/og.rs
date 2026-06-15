use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::net::IpAddr;

use crate::{auth::AuthUser, AppState};

/// SSRF guard — reject URLs whose host resolves to a private/loopback/link-local
/// address (blocks cloud metadata at 169.254.169.254, localhost, internal services).
async fn is_public_url(url: &str) -> bool {
    let parsed = match url::Url::parse(url) {
        Ok(u) => u,
        Err(_) => return false,
    };
    let host = match parsed.host_str() {
        Some(h) => h.to_owned(),
        None => return false,
    };
    let port = parsed.port_or_known_default().unwrap_or(443);
    let addrs: Vec<_> = match tokio::net::lookup_host((host.as_str(), port)).await {
        Ok(it) => it.collect(),
        Err(_) => return false,
    };
    !addrs.is_empty()
        && addrs.iter().all(|sa| match sa.ip() {
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
        })
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

fn http() -> &'static reqwest::Client {
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .user_agent("Kikkacord/1.0 (link preview bot)")
            .redirect(reqwest::redirect::Policy::limited(5))
            .build()
            .expect("http client")
    })
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

    // YouTube / youtu.be → use oEmbed API
    if url.contains("youtube.com/watch") || url.contains("youtu.be/") {
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

    let response = http().get(url).send().await.ok()?;

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

    let html = response.text().await.ok()?;

    // Parse OG tags with a lightweight regex-free parser.
    Some(parse_og(url, &html))
}

fn parse_og(url: &str, html: &str) -> OgData {
    let mut data = OgData {
        url: url.to_owned(),
        ..Default::default()
    };

    // Extract <meta> tags — only scan the first 8KB for perf.
    let scan = &html[..html.len().min(8192)];

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
                "og:image" | "twitter:image" => data.image.get_or_insert(content.clone()),
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
    let (quote, end_q) = if rest.starts_with('"') {
        ('"', rest[1..].find('"').map(|i| (1, i + 1)))
    } else if rest.starts_with('\'') {
        ('\'', rest[1..].find('\'').map(|i| (1, i + 1)))
    } else {
        return None;
    };
    let _ = quote;
    let (start, end) = end_q?;
    Some(rest[start..end].to_owned())
}
