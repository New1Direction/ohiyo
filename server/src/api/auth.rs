use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{
    auth::{create_token, hash_password, jwt_secret, verify_password, AuthUser},
    types::{new_id, now_unix, PublicUser, User},
    AppState,
};

/// Per-client cap on auth attempts to blunt brute-forcing. Generous enough for
/// shared NATs and legit retries; still throttles online password guessing.
const AUTH_MAX_PER_MIN: usize = 40;

/// Per-username cap on login attempts, whatever address they come from, so guessing
/// one account's password from many addresses is throttled too. A side effect: anyone
/// can lock a known username out of login for up to a minute.
const LOGIN_MAX_PER_USERNAME_PER_MIN: usize = 10;

/// Rate-limit key for the requesting client (see [`resolve_client_ip`], [`rate_key_for`]).
pub(crate) fn client_ip(headers: &HeaderMap, addr: &SocketAddr) -> String {
    rate_key_for(resolve_client_ip(
        headers,
        addr.ip(),
        &ProxyTrust::from_env(),
    ))
}

/// Which proxy-set client-address headers this deployment may believe. Any client can
/// send these headers, so each is trusted only when a proxy in front is known to set it.
struct ProxyTrust {
    /// `Fly-Client-IP`, overwritten by Fly's edge proxy. Fly sets `FLY_APP_NAME` on
    /// every machine it runs.
    fly: bool,
    /// `X-Forwarded-For` behind `TRUSTED_PROXY_HOPS` proxies that each append the
    /// address they saw.
    xff_hops: Option<usize>,
}

impl ProxyTrust {
    fn from_env() -> Self {
        ProxyTrust {
            fly: std::env::var_os("FLY_APP_NAME").is_some(),
            xff_hops: parse_proxy_hops(std::env::var("TRUSTED_PROXY_HOPS").ok().as_deref()),
        }
    }
}

/// `TRUSTED_PROXY_HOPS` must be an integer of at least 1; anything else is ignored.
fn parse_proxy_hops(raw: Option<&str>) -> Option<usize> {
    raw.and_then(|v| v.trim().parse::<usize>().ok())
        .filter(|n| *n >= 1)
}

/// The client's address: `Fly-Client-IP` on Fly, else the Nth `X-Forwarded-For` entry
/// from the right behind N trusted proxies, else the socket peer. A missing or invalid
/// trusted header falls through; too few forwarded entries fall back to the peer, never
/// to an entry the client could have written itself.
fn resolve_client_ip(headers: &HeaderMap, peer: IpAddr, trust: &ProxyTrust) -> IpAddr {
    if trust.fly {
        let fly_ip = headers
            .get("fly-client-ip")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse().ok());
        if let Some(ip) = fly_ip {
            return ip;
        }
    }
    if let Some(hops) = trust.xff_hops {
        let forwarded: Vec<&str> = headers
            .get_all("x-forwarded-for")
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(','))
            .collect();
        return forwarded
            .iter()
            .rev()
            .nth(hops - 1)
            .and_then(|entry| entry.trim().parse().ok())
            .unwrap_or(peer);
    }
    peer
}

/// Rate-limit key for a client address. IPv4 (including IPv4-mapped IPv6) is keyed as
/// is; other IPv6 by its /64, the block one subscriber typically controls.
fn rate_key_for(ip: IpAddr) -> String {
    match ip {
        IpAddr::V4(v4) => v4.to_string(),
        IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
            Some(v4) => v4.to_string(),
            None => {
                let s = v6.segments();
                format!("{:x}:{:x}:{:x}:{:x}::/64", s[0], s[1], s[2], s[3])
            }
        },
    }
}

/// Argon2 runs at most this many at once: each takes 19 MiB and tens of milliseconds of CPU.
static ARGON2_PERMITS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);

/// Run an Argon2 hash or verify on the blocking pool, so it never stalls the async
/// executor. The permit moves into the blocking task, so a request dropped mid-hash
/// can't free its slot before the hash is done.
async fn run_argon2<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
) -> Result<T, (StatusCode, String)> {
    let permit = ARGON2_PERMITS
        .acquire()
        .await
        .map_err(crate::api::error::internal)?;
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        work()
    })
    .await
    .map_err(crate::api::error::internal)
}

fn check_auth_rate(state: &AppState, client_ip: &str) -> Result<(), (StatusCode, String)> {
    let key = format!("auth:{}", client_ip);
    if !state
        .rate
        .check(&key, AUTH_MAX_PER_MIN, Duration::from_secs(60))
    {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "too many attempts — give it a moment and try again".into(),
        ));
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct RegisterBody {
    pub username: String,
    pub password: String,
    pub display_name: Option<String>,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: PublicUser,
}

pub async fn register(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<RegisterBody>,
) -> Result<Json<AuthResponse>, (StatusCode, String)> {
    check_auth_rate(&state, &client_ip(&headers, &addr))?;
    if body.username.len() < 2 || body.username.len() > 32 {
        return Err((
            StatusCode::BAD_REQUEST,
            "username must be 2–32 chars".into(),
        ));
    }
    if body.password.len() < 8 {
        return Err((StatusCode::BAD_REQUEST, "password must be ≥8 chars".into()));
    }
    if let Some(name) = &body.display_name {
        crate::api::limits::check_len("display name", name, crate::api::limits::DISPLAY_NAME)?;
    }

    let existing: Option<User> = sqlx::query_as("SELECT * FROM users WHERE username = ?")
        .bind(&body.username)
        .fetch_optional(&state.db)
        .await
        .map_err(crate::api::error::internal)?;

    if existing.is_some() {
        return Err((StatusCode::CONFLICT, "username taken".into()));
    }

    let password = body.password.clone();
    let hash = run_argon2(move || hash_password(&password))
        .await?
        .map_err(crate::api::error::internal)?;

    let id = new_id();
    let display_name = body.display_name.unwrap_or_else(|| body.username.clone());

    sqlx::query(
        "INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES (?,?,?,?,?)",
    )
    .bind(&id)
    .bind(&body.username)
    .bind(&display_name)
    .bind(&hash)
    .bind(now_unix())
    .execute(&state.db)
    .await
    .map_err(crate::api::error::internal)?;

    let user = User {
        id: id.clone(),
        username: body.username,
        display_name,
        password_hash: hash,
        avatar_url: None,
        created_at: now_unix(),
    };

    let secret = jwt_secret();
    // A freshly created user starts at token_version 0 (the column default).
    let token = create_token(&id, 0, &secret).map_err(crate::api::error::internal)?;

    Ok(Json(AuthResponse {
        token,
        user: user.into(),
    }))
}

#[derive(Deserialize)]
pub struct LoginBody {
    pub username: String,
    pub password: String,
}

pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> Result<Json<AuthResponse>, (StatusCode, String)> {
    check_auth_rate(&state, &client_ip(&headers, &addr))?;
    // Exact username: usernames are case-sensitive, so this is one account's key.
    if !state.rate.check(
        &format!("login-user:{}", body.username),
        LOGIN_MAX_PER_USERNAME_PER_MIN,
        Duration::from_secs(60),
    ) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "too many attempts — give it a moment and try again".into(),
        ));
    }
    let user: Option<User> = sqlx::query_as("SELECT * FROM users WHERE username = ?")
        .bind(&body.username)
        .fetch_optional(&state.db)
        .await
        .map_err(crate::api::error::internal)?;

    let user = user.ok_or((StatusCode::UNAUTHORIZED, "invalid credentials".into()))?;

    let (password, hash) = (body.password, user.password_hash.clone());
    if !run_argon2(move || verify_password(&password, &hash)).await? {
        return Err((StatusCode::UNAUTHORIZED, "invalid credentials".into()));
    }

    let secret = jwt_secret();
    let token_version = current_token_version(&state, &user.id).await?;
    let token =
        create_token(&user.id, token_version, &secret).map_err(crate::api::error::internal)?;

    Ok(Json(AuthResponse {
        token,
        user: user.into(),
    }))
}

/// Read a user's current token generation counter (stamped into newly minted tokens).
/// A DB error is propagated, NOT swallowed: silently returning 0 on a fault would mint a
/// version-0 token that "log out everywhere" could never revoke. A missing row → 0 (the
/// column default) is fine for an existing user.
async fn current_token_version(
    state: &AppState,
    user_id: &str,
) -> Result<i64, (StatusCode, String)> {
    let v: Option<i64> = sqlx::query_scalar("SELECT token_version FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    Ok(v.unwrap_or(0))
}

/// POST /auth/logout-everywhere — bump the user's token_version, invalidating every
/// JWT minted before now. The client should discard its token and re-authenticate.
/// (Also the hook a future password-change endpoint calls to force re-login.)
pub async fn logout_everywhere(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<StatusCode, (StatusCode, String)> {
    sqlx::query("UPDATE users SET token_version = token_version + 1 WHERE id = ?")
        .bind(&auth.0)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    // Close the user's live gateway sockets: each one ends when its sender leaves the map.
    state
        .sessions
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&auth.0);
    Ok(StatusCode::NO_CONTENT)
}

// ── Device linking (QR / one-time code) ─────────────────────────────────────────
const LINK_TTL_SECS: i64 = 120;
const LINK_MAX_PER_MIN: usize = 20;

/// A one-time link code: 12 chars from a 31-char unambiguous alphabet (~59 bits, via the
/// OS-seeded ChaCha CSPRNG). With the 2-minute TTL, single use, and per-IP rate limit on
/// redeem, it can't be brute-forced.
fn gen_link_code() -> String {
    use rand::Rng;
    const ALPHA: &[u8] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    let mut rng = rand::thread_rng();
    (0..12)
        .map(|_| ALPHA[rng.gen_range(0..ALPHA.len())] as char)
        .collect()
}

/// Periodic GC: drop expired device-link codes so the table can't grow unbounded.
pub async fn sweep_link_tokens(state: &AppState) {
    let _ = sqlx::query("DELETE FROM device_link_tokens WHERE expires_at < ?")
        .bind(now_unix())
        .execute(&state.db)
        .await;
}

#[derive(Serialize)]
pub struct LinkStartResponse {
    pub code: String,
    pub expires_at: i64,
}

/// POST /devices/link/start — (auth) mint a short-lived one-time code that links a NEW
/// device to THIS account without re-entering the password. Shown as text + QR on the
/// primary device; the new device redeems it at /devices/link/complete.
pub async fn link_start(
    auth: crate::auth::AuthUser,
    State(state): State<AppState>,
) -> Result<Json<LinkStartResponse>, (StatusCode, String)> {
    // One active code per user: clear any previous ones first (caps the table per user
    // and means a fresh request supersedes an unused old code).
    sqlx::query("DELETE FROM device_link_tokens WHERE user_id = ?")
        .bind(&auth.0)
        .execute(&state.db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "db error clearing link codes");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
        })?;
    let code = gen_link_code();
    let expires_at = now_unix() + LINK_TTL_SECS;
    sqlx::query("INSERT INTO device_link_tokens (code, user_id, expires_at) VALUES (?,?,?)")
        .bind(&code)
        .bind(&auth.0)
        .bind(expires_at)
        .execute(&state.db)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "db error minting link code");
            (StatusCode::INTERNAL_SERVER_ERROR, "internal error".into())
        })?;
    Ok(Json(LinkStartResponse { code, expires_at }))
}

#[derive(Deserialize)]
pub struct LinkCompleteBody {
    pub code: String,
}

/// POST /devices/link/complete — (no auth) redeem a link code from a new device and get a
/// session token for the linked account. Single-use (atomically claimed) + short TTL +
/// per-IP rate-limited so the code can't be brute-forced.
pub async fn link_complete(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<LinkCompleteBody>,
) -> Result<Json<AuthResponse>, (StatusCode, String)> {
    let ip = client_ip(&headers, &addr);
    if !state.rate.check(
        &format!("link:{}", ip),
        LINK_MAX_PER_MIN,
        Duration::from_secs(60),
    ) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "too many attempts — give it a moment".into(),
        ));
    }
    // Normalize: strip grouping/whitespace, uppercase.
    let code: String = body
        .code
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect::<String>()
        .to_uppercase();
    if code.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "missing code".into()));
    }
    // Atomically claim the code (delete + return its row) so it can't be redeemed twice.
    let row: Option<(String, i64)> = sqlx::query_as(
        "DELETE FROM device_link_tokens WHERE code = ? RETURNING user_id, expires_at",
    )
    .bind(&code)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| {
        tracing::error!(error = %e, "db error redeeming link code");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal error".to_owned(),
        )
    })?;
    // Same response whether the code never existed, was already used, or expired (it's
    // consumed either way) — so the endpoint isn't an oracle for which codes existed.
    let invalid = || (StatusCode::NOT_FOUND, "invalid or expired code".to_owned());
    let (user_id, expires_at) = row.ok_or_else(invalid)?;
    if expires_at < now_unix() {
        return Err(invalid());
    }
    let user: User = sqlx::query_as("SELECT * FROM users WHERE id = ?")
        .bind(&user_id)
        .fetch_one(&state.db)
        .await
        .map_err(|_| invalid())?;
    let secret = jwt_secret();
    let token_version = current_token_version(&state, &user.id).await?;
    let token = create_token(&user.id, token_version, &secret).map_err(|e| {
        tracing::error!(error = %e, "token error in link_complete");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "internal error".to_owned(),
        )
    })?;
    Ok(Json(AuthResponse {
        token,
        user: user.into(),
    }))
}

#[cfg(test)]
mod client_ip_tests {
    use super::*;

    const PEER: &str = "203.0.113.9";

    fn headers(pairs: &[(&'static str, &str)]) -> HeaderMap {
        let mut map = HeaderMap::new();
        for (name, value) in pairs {
            map.append(*name, value.parse().unwrap());
        }
        map
    }

    fn resolve(pairs: &[(&'static str, &str)], fly: bool, xff_hops: Option<usize>) -> String {
        resolve_client_ip(
            &headers(pairs),
            PEER.parse().unwrap(),
            &ProxyTrust { fly, xff_hops },
        )
        .to_string()
    }

    #[test]
    fn proxy_headers_are_ignored_unless_trusted() {
        let spoofed = [("fly-client-ip", "1.1.1.1"), ("x-forwarded-for", "2.2.2.2")];
        assert_eq!(resolve(&spoofed, false, None), PEER);
    }

    #[test]
    fn fly_client_ip_is_used_on_fly_and_falls_through_when_missing_or_invalid() {
        let both = [("fly-client-ip", "1.1.1.1"), ("x-forwarded-for", "2.2.2.2")];
        assert_eq!(resolve(&both, true, Some(1)), "1.1.1.1");
        assert_eq!(resolve(&[("fly-client-ip", "nonsense")], true, None), PEER);
        assert_eq!(
            resolve(
                &[
                    ("fly-client-ip", "nonsense"),
                    ("x-forwarded-for", "2.2.2.2")
                ],
                true,
                Some(1)
            ),
            "2.2.2.2"
        );
        assert_eq!(resolve(&[], true, None), PEER);
    }

    #[test]
    fn forwarded_for_takes_the_nth_address_from_the_right() {
        let xff = [("x-forwarded-for", "9.9.9.9, 1.1.1.1, 2.2.2.2")];
        assert_eq!(resolve(&xff, false, Some(1)), "2.2.2.2");
        assert_eq!(resolve(&xff, false, Some(2)), "1.1.1.1");
        assert_eq!(resolve(&xff, false, Some(3)), "9.9.9.9");
        // Separate header lines count as one comma-joined list.
        let split = [
            ("x-forwarded-for", "9.9.9.9"),
            ("x-forwarded-for", "1.1.1.1"),
        ];
        assert_eq!(resolve(&split, false, Some(1)), "1.1.1.1");
    }

    #[test]
    fn forwarded_for_falls_back_to_the_peer_never_the_leftmost_entry() {
        let xff = [("x-forwarded-for", "9.9.9.9, 1.1.1.1")];
        assert_eq!(resolve(&xff, false, Some(3)), PEER, "too few entries");
        let garbage = [("x-forwarded-for", "9.9.9.9, not-an-ip")];
        assert_eq!(resolve(&garbage, false, Some(1)), PEER, "invalid entry");
        assert_eq!(resolve(&[], false, Some(1)), PEER, "no header");
    }

    #[test]
    fn trusted_proxy_hops_must_be_a_positive_integer() {
        for (raw, hops) in [
            (Some("1"), Some(1)),
            (Some(" 2 "), Some(2)),
            (Some("0"), None),
            (Some("-1"), None),
            (Some("two"), None),
            (None, None),
        ] {
            assert_eq!(parse_proxy_hops(raw), hops, "{raw:?}");
        }
    }

    #[test]
    fn ipv6_clients_are_keyed_by_their_64_and_mapped_ipv4_as_ipv4() {
        let key = |ip: &str| rate_key_for(ip.parse().unwrap());
        assert_eq!(key("198.51.100.7"), "198.51.100.7");
        assert_eq!(key("::ffff:198.51.100.7"), "198.51.100.7");
        assert_eq!(
            key("2001:db8:aa:bb:1:2:3:4"),
            key("2001:db8:aa:bb:ffff:ffff:ffff:ffff")
        );
        assert_ne!(key("2001:db8:aa:bb::1"), key("2001:db8:aa:bc::1"));
        assert_eq!(key("2001:db8:aa:bb::1"), "2001:db8:aa:bb::/64");
    }
}
