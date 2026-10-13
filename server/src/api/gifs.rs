//! GIF search through KLIPY (Tenor's API, which the app used to call from the browser, was shut
//! down by Google on 30 June 2026).
//!
//! The server keeps the KLIPY key and asks KLIPY on the person's behalf, so the search goes out
//! without their IP address, and with no id of theirs (KLIPY's optional `customer_id` is left
//! out). The answer is cut down to what the picker needs, and only links on KLIPY's own media
//! hosts over https survive.
//!
//! The media itself is NOT fetched or stored here: KLIPY's integration rules say standard
//! integrations "must load KLIPY media directly and must not create a partner-operated media
//! cache" (https://docs.klipy.com, Integration Requirements). So previews and sent GIFs load from
//! KLIPY's media hosts in the browser, like any picture linked in a chat; the privacy page says so.
//!
//! API (https://docs.klipy.com/gifs-api/gifs-search-api, /gifs-api/gifs-trending-api):
//! `GET {base}/api/v1/{app_key}/gifs/search?q=&page=&per_page=&content_filter=` and
//! `.../gifs/trending?page=&per_page=&content_filter=`, answering
//! `{result, data: {data: [{id, title, file: {hd|md|sm|xs: {gif|webp|…: {url, width, height}}}}],
//! current_page, per_page, has_next}}`.

use std::time::Duration;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{auth::AuthUser, AppState};

pub const KLIPY_API: &str = "https://api.klipy.com";
const KLIPY_TIMEOUT: Duration = Duration::from_secs(4);
/// KLIPY's media hosts (docs: Network Requirements). Links anywhere else are dropped.
const MEDIA_HOSTS: [&str; 3] = ["static.klipy.com", "static1.klipy.com", "static2.klipy.com"];
const PER_PAGE: u32 = 24;
const MAX_PAGE: u32 = 50;
const MAX_QUERY_CHARS: usize = 100;
/// Searches and trending pages per account per minute: plenty while typing, little for a script.
const SEARCHES_PER_MINUTE: usize = 30;

#[derive(Clone)]
pub struct Klipy {
    pub api_key: String,
    /// Tests point this at a local stand-in for KLIPY.
    pub base_url: String,
    pub timeout: Duration,
    pub client: reqwest::Client,
}

impl Klipy {
    pub fn new(api_key: impl Into<String>) -> Self {
        Klipy {
            api_key: api_key.into(),
            base_url: KLIPY_API.to_owned(),
            timeout: KLIPY_TIMEOUT,
            client: reqwest::Client::new(),
        }
    }

    /// Read once at startup; `None` unless `KLIPY_API_KEY` is set to a plausible key (letters,
    /// digits, `-` and `_`, since it goes into the request path).
    pub fn from_env() -> Option<Self> {
        let key = std::env::var("KLIPY_API_KEY").unwrap_or_default();
        let key = key.trim();
        let plausible = !key.is_empty()
            && key.len() <= 200
            && key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        if !key.is_empty() && !plausible {
            tracing::warn!(
                "KLIPY_API_KEY is set but doesn't look like a key; GIF search stays off"
            );
        }
        plausible.then(|| Klipy::new(key))
    }

    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

// Never print the key.
impl std::fmt::Debug for Klipy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Klipy")
            .field("api_key", &"<redacted>")
            .field("base_url", &self.base_url)
            .field("timeout", &self.timeout)
            .finish()
    }
}

#[derive(Deserialize)]
pub struct SearchParams {
    pub q: Option<String>,
    pub page: Option<u32>,
}

#[derive(Deserialize)]
pub struct PageParams {
    pub page: Option<u32>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Gif {
    pub id: String,
    pub title: String,
    /// The GIF itself (KLIPY's `md` size): what a message sends.
    pub url: String,
    /// A small preview for the picker (`sm`, webp if there is one).
    pub preview: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize)]
pub struct GifPage {
    pub available: bool,
    pub results: Vec<Gif>,
    pub page: u32,
    pub has_next: bool,
}

type ApiError = (StatusCode, String);

fn bad(message: &str) -> ApiError {
    (StatusCode::BAD_REQUEST, message.into())
}

fn unavailable() -> GifPage {
    GifPage {
        available: false,
        results: Vec::new(),
        page: 1,
        has_next: false,
    }
}

fn page_of(page: Option<u32>) -> Result<u32, ApiError> {
    let page = page.unwrap_or(1);
    if (1..=MAX_PAGE).contains(&page) {
        Ok(page)
    } else {
        Err(bad("pages go from 1 to 50"))
    }
}

/// A KLIPY media link we'll hand to the app: https, on one of KLIPY's media hosts.
fn klipy_media_url(value: &Value) -> Option<String> {
    let raw = value.as_str()?;
    let url = url::Url::parse(raw).ok()?;
    let host = url.host_str()?;
    (url.scheme() == "https"
        && MEDIA_HOSTS.contains(&host)
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none())
    .then(|| url.to_string())
}

/// The first usable link among `(size, format)` choices, with its size.
fn pick(file: &Value, choices: &[(&str, &str)]) -> Option<(String, u32, u32)> {
    choices.iter().find_map(|(size, format)| {
        let media = &file[size][format];
        let url = klipy_media_url(&media["url"])?;
        let dim = |k: &str| {
            media[k]
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .unwrap_or(0)
        };
        Some((url, dim("width"), dim("height")))
    })
}

/// One KLIPY item → what the picker needs, or `None` when its links aren't KLIPY's.
fn gif_from(item: &Value) -> Option<Gif> {
    let id = match &item["id"] {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    let file = &item["file"];
    let (url, width, height) = pick(file, &[("md", "gif"), ("hd", "gif"), ("sm", "gif")])?;
    let (preview, _, _) = pick(
        file,
        &[
            ("sm", "webp"),
            ("sm", "gif"),
            ("xs", "webp"),
            ("xs", "gif"),
            ("md", "webp"),
        ],
    )
    .unwrap_or((url.clone(), width, height));
    let title: String = item["title"]
        .as_str()
        .unwrap_or("GIF")
        .chars()
        .take(100)
        .collect();
    Some(Gif {
        id,
        title: if title.trim().is_empty() {
            "GIF".to_owned()
        } else {
            title
        },
        url,
        preview,
        width,
        height,
    })
}

fn bad_gateway() -> ApiError {
    (
        StatusCode::BAD_GATEWAY,
        "GIF search isn't answering right now — try again in a moment".into(),
    )
}

/// Ask KLIPY for one page of `endpoint` ("search" or "trending").
async fn ask_klipy(
    klipy: &Klipy,
    endpoint: &str,
    query: Option<&str>,
    page: u32,
) -> Result<GifPage, ApiError> {
    let url = format!(
        "{}/api/v1/{}/gifs/{endpoint}",
        klipy.base_url.trim_end_matches('/'),
        klipy.api_key
    );
    let mut params: Vec<(&str, String)> = vec![
        ("page", page.to_string()),
        ("per_page", PER_PAGE.to_string()),
        ("content_filter", "medium".to_owned()),
    ];
    if let Some(q) = query {
        params.insert(0, ("q", q.to_owned()));
    }
    let res = klipy
        .client
        .get(&url)
        .query(&params)
        .timeout(klipy.timeout)
        .send()
        .await
        .map_err(|e| {
            // The request URL carries the key: log the error without it.
            tracing::warn!(error = %e.without_url(), "KLIPY GIF {endpoint} failed");
            bad_gateway()
        })?;
    if !res.status().is_success() {
        tracing::warn!(status = %res.status(), "KLIPY GIF {endpoint} answered with an error");
        return Err(bad_gateway());
    }
    let body: Value = res.json().await.map_err(|e| {
        tracing::warn!(error = %e.without_url(), "KLIPY GIF {endpoint} answer wasn't JSON");
        bad_gateway()
    })?;
    let data = &body["data"];
    let results = data["data"]
        .as_array()
        .map(|items| items.iter().filter_map(gif_from).collect())
        .unwrap_or_default();
    Ok(GifPage {
        available: true,
        results,
        page,
        has_next: data["has_next"].as_bool().unwrap_or(false),
    })
}

fn within_limit(state: &AppState, user_id: &str) -> Result<(), ApiError> {
    if state.rate.check(
        &format!("gif-search:{user_id}"),
        SEARCHES_PER_MINUTE,
        Duration::from_secs(60),
    ) {
        Ok(())
    } else {
        Err((
            StatusCode::TOO_MANY_REQUESTS,
            "slow down — try again in a minute".into(),
        ))
    }
}

/// GET /gifs/search?q=&page= — search KLIPY through this server.
pub async fn search(
    AuthUser(user_id, _): AuthUser,
    State(state): State<AppState>,
    Query(params): Query<SearchParams>,
) -> Result<Json<GifPage>, ApiError> {
    let Some(klipy) = state.klipy.as_ref() else {
        return Ok(Json(unavailable()));
    };
    let q = params.q.as_deref().map(str::trim).unwrap_or_default();
    if q.is_empty() {
        return Err(bad("type something to search for"));
    }
    if q.chars().count() > MAX_QUERY_CHARS {
        return Err(bad("a GIF search is at most 100 characters"));
    }
    let page = page_of(params.page)?;
    within_limit(&state, &user_id)?;
    Ok(Json(ask_klipy(klipy, "search", Some(q), page).await?))
}

/// GET /gifs/trending?page= — KLIPY's trending GIFs through this server.
pub async fn trending(
    AuthUser(user_id, _): AuthUser,
    State(state): State<AppState>,
    Query(params): Query<PageParams>,
) -> Result<Json<GifPage>, ApiError> {
    let Some(klipy) = state.klipy.as_ref() else {
        return Ok(Json(unavailable()));
    };
    let page = page_of(params.page)?;
    within_limit(&state, &user_id)?;
    Ok(Json(ask_klipy(klipy, "trending", None, page).await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_https_links_on_klipys_media_hosts_survive() {
        for ok in [
            "https://static.klipy.com/ii/a/b.gif",
            "https://static1.klipy.com/x.webp",
            "https://static2.klipy.com/y.gif?v=1",
        ] {
            assert!(klipy_media_url(&json!(ok)).is_some(), "{ok}");
        }
        for bad in [
            "http://static.klipy.com/a.gif",
            "https://static.klipy.com.evil.example/a.gif",
            "https://evil.example/static.klipy.com/a.gif",
            "https://user:pw@static.klipy.com/a.gif",
            "https://static.klipy.com:8443/a.gif",
            "javascript:alert(1)",
            "",
        ] {
            assert!(klipy_media_url(&json!(bad)).is_none(), "{bad}");
        }
        assert!(klipy_media_url(&json!(42)).is_none());
    }

    #[test]
    fn the_debug_form_never_shows_the_key() {
        let k = Klipy::new("super-secret-key");
        assert!(!format!("{k:?}").contains("super-secret-key"));
    }
}
