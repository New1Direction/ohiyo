mod api;
mod auth;
mod db;
mod gateway;
mod ratelimit;
mod search;
mod types;

use std::net::SocketAddr;

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

/// Ensure `JWT_SECRET` is present. If the operator didn't set one (no env, no
/// `.env`), generate a strong ephemeral secret for this process so we never fall
/// back to a hardcoded, forgeable value. Tokens won't survive a restart in that
/// case — set `JWT_SECRET` in production for stable sessions.
fn ensure_jwt_secret() {
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

// ── Entry point ───────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "server=info,tower_http=info".to_owned()),
        )
        .init();

    ensure_jwt_secret();

    let database_url =
        std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite:kikkacord.db".to_owned());

    let db = db::connect(&database_url).await?;
    tracing::info!("Database connected");

    // Bring up the Meilisearch index if full-text search is enabled (logs + continues
    // on failure so an unreachable search service never blocks boot).
    if search::search_enabled() {
        search::ensure_index().await;
    }

    let state = AppState {
        db,
        sessions: gateway::new_session_map(),
        voice: gateway::new_voice_rooms(),
        typing_cooldowns: gateway::new_typing_cooldowns(),
        rate: RateLimiter::new(),
        tickets: gateway::new_ws_tickets(),
        activities: gateway::new_activities(),
        idle: gateway::new_idle_set(),
        watch: gateway::new_watch_sessions(),
    };

    // Disappearing messages: a periodic sweeper deletes lapsed messages server-side
    // and notifies connected clients (so ciphertext doesn't linger past its TTL).
    {
        let sweep_state = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                api::messages::sweep_expired(&sweep_state).await;
                // Account-level dead-man's switch: wipe data for users gone too long.
                api::users::sweep_deadman(&sweep_state).await;
                // Drop expired device-link codes so the table can't grow unbounded.
                api::auth::sweep_link_tokens(&sweep_state).await;
            }
        });
    }

    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = Router::new()
        .nest("/api/v1", api::router())
        .route("/gateway", get(gateway::ws_handler))
        .route("/files/{id}", get(api::files::serve_file))
        // Liveness probe for the platform load balancer (Fly health check).
        .route("/healthz", get(|| async { "ok" }))
        .with_state(state)
        .layer(axum::middleware::from_fn(security_headers))
        .layer(cors)
        // 16 MiB default for JSON/avatar/emoji; the /upload route overrides to 2 GiB.
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024));

    let addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:3000".to_owned());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("Kikkacord server listening on {addr}");
    // Connect-info lets auth handlers rate-limit by client IP.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;

    Ok(())
}
