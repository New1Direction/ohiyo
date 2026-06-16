//! Kikkacord server library.
//!
//! The binary (`main.rs`) is a thin wrapper around this crate: it wires up logging,
//! the database, the background sweep loop, and the network listener. Everything that
//! defines *what the server is* — the module tree, the shared [`AppState`], the
//! security-headers middleware, and the assembled router — lives here so that
//! integration tests in `tests/` can boot the exact same application stack that ships
//! in production (rather than a hand-rolled approximation that could drift).

pub mod api;
pub mod auth;
pub mod db;
pub mod gateway;
pub mod ratelimit;
pub mod search;
pub mod types;

use axum::{
    extract::{DefaultBodyLimit, Request},
    http::HeaderValue,
    middleware::Next,
    response::Response,
    routing::get,
    Router,
};
use gateway::{SessionMap, TypingCooldowns, VoiceRooms};
use rand::Rng;
use ratelimit::RateLimiter;
use sqlx::SqlitePool;
use tower_http::cors::{Any, CorsLayer};

// ── Shared application state ──────────────────────────────────────────────────

#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub sessions: SessionMap,
    /// Live voice-channel presence: channel_id → (user_id → member).
    pub voice: VoiceRooms,
    /// Per-(user, channel) throttle timestamps for typing pings.
    pub typing_cooldowns: TypingCooldowns,
    /// Sliding-window limiter for auth (brute-force) and message (spam) endpoints.
    pub rate: RateLimiter,
    /// One-time gateway tickets — keeps the long-lived JWT out of the WebSocket URL.
    pub tickets: gateway::WsTickets,
    /// Live rich-presence: user_id → current activity (playing/watching/working).
    pub activities: gateway::Activities,
    /// Connected users currently idle (no input) → drives the idle presence dot.
    pub idle: gateway::IdleSet,
    /// Live watch-party sessions: channel_id → synced video state.
    pub watch: gateway::WatchSessions,
}

/// Build a fresh [`AppState`] around a database pool, initialising all the in-memory
/// live-presence maps. Shared by `main` and the integration-test harness so both
/// construct state identically.
pub fn build_state(db: SqlitePool) -> AppState {
    AppState {
        db,
        sessions: gateway::new_session_map(),
        voice: gateway::new_voice_rooms(),
        typing_cooldowns: gateway::new_typing_cooldowns(),
        rate: RateLimiter::new(),
        tickets: gateway::new_ws_tickets(),
        activities: gateway::new_activities(),
        idle: gateway::new_idle_set(),
        watch: gateway::new_watch_sessions(),
    }
}

/// Ensure `JWT_SECRET` is present. If the operator didn't set one (no env, no
/// `.env`), generate a strong ephemeral secret for this process so we never fall
/// back to a hardcoded, forgeable value. Tokens won't survive a restart in that
/// case — set `JWT_SECRET` in production for stable sessions.
pub fn ensure_jwt_secret() {
    let missing = std::env::var("JWT_SECRET")
        .map(|s| s.trim().is_empty())
        .unwrap_or(true);
    if missing {
        let secret: String = rand::thread_rng()
            .sample_iter(&rand::distributions::Alphanumeric)
            .take(48)
            .map(char::from)
            .collect();
        std::env::set_var("JWT_SECRET", secret);
        tracing::warn!(
            "JWT_SECRET not set — generated an ephemeral secret for this run. \
             Set JWT_SECRET in the environment for stable sessions across restarts."
        );
    }
}

// ── Security headers ──────────────────────────────────────────────────────────
// Applied to EVERY response (API + the /files upload-serving route). The locked-down
// CSP + nosniff are what matter most on /files: they stop an uploaded HTML/SVG from
// executing script when opened directly. HSTS only takes effect over HTTPS (ignored in
// local http dev). The app document's own CSP/permissions are set by whatever serves
// the SPA — this server is API-only.
async fn security_headers(req: Request, next: Next) -> Response {
    let mut res = next.run(req).await;
    let h = res.headers_mut();
    h.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    h.insert(
        "referrer-policy",
        HeaderValue::from_static("strict-origin-when-cross-origin"),
    );
    h.insert("x-frame-options", HeaderValue::from_static("DENY"));
    h.insert(
        "content-security-policy",
        HeaderValue::from_static(
            "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; sandbox",
        ),
    );
    h.insert(
        "strict-transport-security",
        HeaderValue::from_static("max-age=31536000; includeSubDomains"),
    );
    res
}

/// Assemble the full application router with the production middleware stack
/// (security headers, permissive CORS, 16 MiB default body limit). The returned
/// `Router` still needs connect-info wired in by the caller via
/// `into_make_service_with_connect_info::<SocketAddr>()` so IP-based rate limiting
/// sees the real peer address.
pub fn build_app(state: AppState) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .nest("/api/v1", api::router())
        .route("/gateway", get(gateway::ws_handler))
        .route("/files/{id}", get(api::files::serve_file))
        // Liveness probe for the platform load balancer (Fly health check).
        .route("/healthz", get(|| async { "ok" }))
        .with_state(state)
        .layer(axum::middleware::from_fn(security_headers))
        .layer(cors)
        // 16 MiB default for JSON/avatar/emoji; the /upload route overrides to 2 GiB.
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
}
