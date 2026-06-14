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

use axum::{http::StatusCode, Json};
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha1::Sha1;

use crate::auth::AuthUser;

type HmacSha1 = Hmac<Sha1>;

const DEFAULT_TURN_TTL_SECS: i64 = 86_400; // 24h
const DEFAULT_STUN_URLS: &str = "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302";

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
    let mut mac = HmacSha1::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts a key of any length");
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

pub async fn ice_servers(
    AuthUser(user_id): AuthUser,
) -> Result<Json<IceServersResponse>, (StatusCode, &'static str)> {
    let stun_urls = split_urls(
        &std::env::var("STUN_URLS").unwrap_or_else(|_| DEFAULT_STUN_URLS.to_owned()),
    );
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

    let mut ttl_expires_at = None;
    if !secret.is_empty() && !turn_urls.is_empty() {
        let ttl = std::env::var("TURN_TTL")
            .ok()
            .and_then(|v| v.trim().parse::<i64>().ok())
            .filter(|&v| v > 0)
            .unwrap_or(DEFAULT_TURN_TTL_SECS);
        let expiry = chrono::Utc::now().timestamp() + ttl;
        let username = format!("{expiry}:{user_id}"); // expiry FIRST, colon-separated
        let credential = turn_credential(&secret, &username);
        ice_servers.push(IceServer {
            urls: turn_urls,
            username: Some(username),
            credential: Some(credential),
        });
        ttl_expires_at = Some(expiry);
    } else {
        tracing::debug!("TURN_SECRET/TURN_URLS unset — serving STUN-only ICE config");
    }

    Ok(Json(IceServersResponse {
        ice_servers,
        ttl_expires_at,
    }))
}

#[cfg(test)]
mod tests {
    use super::turn_credential;

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
