// GET /api/v1/ice-servers  (auth required)
//
// Always serves STUN; serves time-limited TURN credentials when a coturn
// `use-auth-secret` deployment is configured. Credentials follow the standard
// "TURN REST API" scheme:
//   username   = "<unix_expiry>:<user_id>"
//   credential = base64_STANDARD( HMAC_SHA1(key = secret, msg = username) )
//
// The key/msg direction, SHA-1 (not SHA-256), and STANDARD base64 (+ / =, NOT
// url-safe) all matter — getting any wrong makes coturn 401 silently, and the
// browser surfaces only a generic ICE failure. See the unit test below.
//
// With Cloudflare Realtime's TURN configured instead (or as well), the server asks
// Cloudflare for short-lived credentials on each call and adds its servers after the
// STUN ones. A failing or slow Cloudflare leaves the answer as it would be without it.

use std::time::Duration;

use axum::{extract::State, http::StatusCode, Json};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha1::Sha1;

use crate::{auth::AuthUser, AppState};

type HmacSha1 = Hmac<Sha1>;

const DEFAULT_TURN_TTL_SECS: i64 = 86_400; // 24h
const DEFAULT_STUN_URLS: &str = "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302";

/// Where Cloudflare Realtime's credentials API lives.
pub const CLOUDFLARE_TURN_API: &str = "https://rtc.live.cloudflare.com";
/// Well under the 5 s the client waits for this endpoint, so the direct-only answer
/// still reaches it in time when Cloudflare is slow.
const CLOUDFLARE_TIMEOUT: Duration = Duration::from_secs(3);
/// How often one account may make the server ask Cloudflare, per minute. Joining a call
/// asks once; past this the account gets the direct-only answer, so a loop can't wear
/// out the TURN key's standing with Cloudflare.
const CLOUDFLARE_ASKS_PER_MIN: usize = 20;

/// Cloudflare Realtime's TURN relay, used when `CLOUDFLARE_TURN_KEY_ID` and
/// `CLOUDFLARE_TURN_API_TOKEN` are both set. The TURN key is a long-term secret that
/// stays on the server; each caller gets short-lived credentials minted from it.
#[derive(Clone)]
pub struct CloudflareTurn {
    pub key_id: String,
    pub api_token: String,
    /// Tests point this at a local stand-in for Cloudflare.
    pub base_url: String,
    pub timeout: Duration,
    pub client: reqwest::Client,
}

impl CloudflareTurn {
    pub fn new(key_id: impl Into<String>, api_token: impl Into<String>) -> Self {
        CloudflareTurn {
            key_id: key_id.into(),
            api_token: api_token.into(),
            base_url: CLOUDFLARE_TURN_API.to_owned(),
            timeout: CLOUDFLARE_TIMEOUT,
            client: reqwest::Client::new(),
        }
    }

    /// Read once at startup; `None` unless both values are set.
    pub fn from_env() -> Option<Self> {
        let read = |name: &str| {
            std::env::var(name)
                .map(|v| v.trim().to_owned())
                .unwrap_or_default()
        };
        let (key_id, api_token) = (
            read("CLOUDFLARE_TURN_KEY_ID"),
            read("CLOUDFLARE_TURN_API_TOKEN"),
        );
        if key_id.is_empty() || api_token.is_empty() {
            return None;
        }
        Some(Self::new(key_id, api_token))
    }

    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// Short-lived credentials for one caller, valid for `ttl` seconds. URLs on port 53
    /// are dropped: Cloudflare's docs say browsers block that port, so they only time out.
    async fn ice_servers(&self, ttl: i64) -> Result<Vec<IceServer>, String> {
        let url = format!(
            "{}/v1/turn/keys/{}/credentials/generate-ice-servers",
            self.base_url.trim_end_matches('/'),
            self.key_id
        );
        let res = self
            .client
            .post(url)
            .bearer_auth(&self.api_token)
            .json(&serde_json::json!({ "ttl": ttl }))
            .timeout(self.timeout)
            .send()
            .await
            .map_err(|e| e.without_url().to_string())?;
        let status = res.status();
        if !status.is_success() {
            return Err(format!("Cloudflare answered {status}"));
        }
        let answer: CloudflareAnswer = res.json().await.map_err(|e| e.without_url().to_string())?;
        Ok(answer
            .ice_servers
            .into_iter()
            .filter_map(|server| {
                let urls: Vec<String> = server
                    .urls
                    .into_vec()
                    .into_iter()
                    .filter(|url| !uses_port_53(url))
                    .collect();
                (!urls.is_empty()).then_some(IceServer {
                    urls,
                    username: server.username,
                    credential: server.credential,
                })
            })
            .collect())
    }
}

/// Never prints the API token.
impl std::fmt::Debug for CloudflareTurn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CloudflareTurn")
            .field("key_id", &self.key_id)
            .field("api_token", &"<redacted>")
            .field("base_url", &self.base_url)
            .field("timeout", &self.timeout)
            .finish()
    }
}

#[derive(Deserialize)]
struct CloudflareAnswer {
    #[serde(rename = "iceServers")]
    ice_servers: Vec<CloudflareIceServer>,
}

#[derive(Deserialize)]
struct CloudflareIceServer {
    urls: Urls,
    username: Option<String>,
    credential: Option<String>,
}

/// WebRTC allows `urls` to be one string or a list.
#[derive(Deserialize)]
#[serde(untagged)]
enum Urls {
    One(String),
    Many(Vec<String>),
}

impl Urls {
    fn into_vec(self) -> Vec<String> {
        match self {
            Urls::One(url) => vec![url],
            Urls::Many(urls) => urls,
        }
    }
}

/// `turn:host:53?transport=udp`, `stun:host:53` or `turn:[::1]:53`.
fn uses_port_53(url: &str) -> bool {
    let after_scheme = url.split_once(':').map_or(url, |(_, rest)| rest);
    let host_port = after_scheme.split('?').next().unwrap_or(after_scheme);
    host_port
        .rsplit_once(':')
        .is_some_and(|(_, port)| port == "53")
}

#[derive(Debug, Serialize)]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct IceServersResponse {
    #[serde(rename = "iceServers")]
    pub ice_servers: Vec<IceServer>,
    #[serde(rename = "ttlExpiresAt", skip_serializing_if = "Option::is_none")]
    pub ttl_expires_at: Option<i64>,
}

/// credential = base64_STANDARD( HMAC_SHA1(key = secret, msg = username) ).
fn turn_credential(secret: &str, username: &str) -> String {
    let mut mac =
        HmacSha1::new_from_slice(secret.as_bytes()).expect("HMAC accepts a key of any length");
    mac.update(username.as_bytes());
    let tag = mac.finalize().into_bytes();
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(tag)
}

fn split_urls(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

fn turn_ttl() -> i64 {
    std::env::var("TURN_TTL")
        .ok()
        .and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(DEFAULT_TURN_TTL_SECS)
}

pub async fn ice_servers(
    AuthUser(user_id, _): AuthUser,
    State(state): State<AppState>,
) -> Result<Json<IceServersResponse>, (StatusCode, &'static str)> {
    let stun_urls =
        split_urls(&std::env::var("STUN_URLS").unwrap_or_else(|_| DEFAULT_STUN_URLS.to_owned()));
    let mut ice_servers = vec![IceServer {
        urls: stun_urls,
        username: None,
        credential: None,
    }];

    // `.trim()` guards a stray newline/space desyncing from coturn's static-auth-secret.
    let secret = std::env::var("TURN_SECRET")
        .map(|s| s.trim().to_owned())
        .unwrap_or_default();
    let turn_urls = split_urls(&std::env::var("TURN_URLS").unwrap_or_default());

    let ttl = turn_ttl();
    let expiry = chrono::Utc::now().timestamp() + ttl;
    let mut ttl_expires_at = None;
    if !secret.is_empty() && !turn_urls.is_empty() {
        let username = format!("{expiry}:{user_id}"); // expiry FIRST, colon-separated
        let credential = turn_credential(&secret, &username);
        ice_servers.push(IceServer {
            urls: turn_urls,
            username: Some(username),
            credential: Some(credential),
        });
        ttl_expires_at = Some(expiry);
    } else {
        tracing::debug!("TURN_SECRET/TURN_URLS unset — no self-hosted TURN in the ICE config");
    }

    if let Some(cloudflare) = &state.cloudflare_turn {
        if !state.rate.check(
            &format!("ice-cloudflare:{user_id}"),
            CLOUDFLARE_ASKS_PER_MIN,
            Duration::from_secs(60),
        ) {
            tracing::debug!(%user_id, "asked for relay credentials too often — direct-only answer");
        } else {
            match cloudflare.ice_servers(ttl).await {
                Ok(servers) => {
                    ice_servers.extend(servers);
                    ttl_expires_at = Some(expiry);
                }
                Err(e) => {
                    tracing::warn!(
                        "Cloudflare TURN credentials unavailable, answering without the relay: {e}"
                    )
                }
            }
        }
    }

    Ok(Json(IceServersResponse {
        ice_servers,
        ttl_expires_at,
    }))
}

#[cfg(test)]
mod tests {
    use super::{turn_credential, uses_port_53, CloudflareTurn};

    #[test]
    fn the_cloudflare_settings_never_print_the_api_token() {
        let printed = format!("{:?}", CloudflareTurn::new("key-id", "very-secret-token"));
        assert!(printed.contains("key-id"));
        assert!(!printed.contains("very-secret-token"), "{printed}");
    }

    #[test]
    fn port_53_is_spotted_in_every_url_form() {
        assert!(uses_port_53("turn:turn.cloudflare.com:53?transport=udp"));
        assert!(uses_port_53("stun:stun.cloudflare.com:53"));
        assert!(uses_port_53("turn:[2606:4700::1]:53"));
        assert!(!uses_port_53("turn:turn.cloudflare.com:3478?transport=udp"));
        assert!(!uses_port_53(
            "turns:turn.cloudflare.com:5349?transport=tcp"
        ));
        assert!(!uses_port_53("stun:stun.example.com"));
        assert!(!uses_port_53("turn:host.example:5353"));
    }

    // Locks HMAC-SHA1 + STANDARD base64. Equivalent to:
    //   printf '%s' '12334939:1234' | openssl dgst -sha1 -hmac 'north' -binary | openssl base64
    // A '-'/'_' result == url-safe (wrong); 40 hex chars == hex (wrong); 44 chars == SHA-256 (wrong).
    #[test]
    fn rest_credential_matches_known_vector() {
        assert_eq!(
            turn_credential("north", "12334939:1234"),
            "2QMLfAz0OwaufQAZrV0G/CoWA18="
        );
    }
}
