//! Ohiyo server library.
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
pub mod instance_router;
pub mod provision;
pub mod ratelimit;
pub mod search;
pub mod types;

use axum::{
    extract::{DefaultBodyLimit, Request, State},
    http::{HeaderValue, StatusCode},
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
    /// Cloud orchestrator for Instant Servers — fake in tests/dev, Fly Machines in prod.
    pub provisioner: std::sync::Arc<dyn provision::MachineProvisioner>,
}

/// Build a fresh [`AppState`] around a database pool, initialising all the in-memory
/// live-presence maps. Shared by `main` and the integration-test harness so both
/// construct state identically.
pub fn build_state(db: SqlitePool) -> AppState {
    // Pick the provisioner: the real Fly Machines client when a token is present,
    // otherwise the in-memory fake (tests + local dev exercise the full flow with zero
    // infra, and never accidentally hit a cloud API).
    let provisioner: std::sync::Arc<dyn provision::MachineProvisioner> =
        if std::env::var("FLY_API_TOKEN").is_ok() {
            std::sync::Arc::new(provision::fly::FlyProvisioner::from_env())
        } else {
            std::sync::Arc::new(provision::fake::FakeProvisioner::default())
        };
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
        provisioner,
    }
}

/// Shortest acceptable production `JWT_SECRET`. Anything weaker is treated as
/// unset — a guessable signing key forges sessions.
const MIN_JWT_SECRET_LEN: usize = 32;

/// Validate runtime configuration before the server accepts any traffic.
///
/// In **release** builds this FAILS FAST on misconfiguration that would otherwise
/// cause a silently broken or insecure production boot — there is no safe default
/// for these. In **debug** builds it backfills convenient localhost defaults so
/// `cargo run` works with zero setup.
///
/// Guards:
/// - `JWT_SECRET` — an ephemeral fallback would log every user out on each restart;
///   a weak one is forgeable. Release requires a strong value.
/// - `PUBLIC_BASE_URL` — it prefixes avatar/banner URLs that are *persisted* to the
///   DB, so an unset value bakes unreachable `http://localhost` links in permanently.
pub fn validate_config() -> anyhow::Result<()> {
    let release = !cfg!(debug_assertions);
    let jwt = std::env::var("JWT_SECRET").ok();
    let base = std::env::var("PUBLIC_BASE_URL").ok();
    let plan = plan_config(jwt.as_deref(), base.as_deref(), release)?;

    if plan.backfill_jwt {
        let generated: String = rand::thread_rng()
            .sample_iter(&rand::distributions::Alphanumeric)
            .take(48)
            .map(char::from)
            .collect();
        std::env::set_var("JWT_SECRET", generated);
        tracing::warn!(
            "JWT_SECRET not set — generated an ephemeral dev secret. Set JWT_SECRET \
             for stable sessions across restarts."
        );
    }
    if plan.backfill_base {
        std::env::set_var("PUBLIC_BASE_URL", "http://localhost:3000");
        tracing::warn!("PUBLIC_BASE_URL not set — defaulting to http://localhost:3000 (dev only).");
    }

    // A non-empty CORS_ALLOWED_ORIGINS that parses to ZERO valid origins would
    // silently deny every cross-origin request (including the desktop client) with no
    // diagnostic. Catch that misconfiguration at boot instead of in the field.
    if let Ok(raw) = std::env::var("CORS_ALLOWED_ORIGINS") {
        if !raw.trim().is_empty() && parse_cors_origins(&raw).is_empty() {
            if release {
                anyhow::bail!(
                    "CORS_ALLOWED_ORIGINS is set but no valid origins parsed — fix or \
                     unset it (an empty allowlist blocks every cross-origin request)."
                );
            }
            tracing::warn!(
                "CORS_ALLOWED_ORIGINS set but no valid origins parsed — cross-origin requests will be blocked."
            );
        }
    }
    Ok(())
}

/// What `validate_config` should do for the observed environment. Whether each var
/// needs a dev backfill is decided here, separated from the env side-effects so the
/// security-critical fail-fast logic is unit-testable without mutating global state.
struct ConfigPlan {
    backfill_jwt: bool,
    backfill_base: bool,
}

/// Decide config actions from the observed `JWT_SECRET` / `PUBLIC_BASE_URL` and the
/// build profile. In `release`, anything unsafe is a hard error (no safe default);
/// otherwise the caller backfills a dev default.
fn plan_config(jwt: Option<&str>, base: Option<&str>, release: bool) -> anyhow::Result<ConfigPlan> {
    let jwt_ok = jwt
        .map(|s| s.trim().len() >= MIN_JWT_SECRET_LEN)
        .unwrap_or(false);
    let base_ok = base.map(|s| !s.trim().is_empty()).unwrap_or(false);

    if release {
        if !jwt_ok {
            anyhow::bail!(
                "JWT_SECRET is unset or too weak (need ≥ {MIN_JWT_SECRET_LEN} chars). \
                 Generate one — `openssl rand -base64 48` — and set it before launch. \
                 An ephemeral secret would log every user out on each restart."
            );
        }
        if !base_ok {
            anyhow::bail!(
                "PUBLIC_BASE_URL is required in production (e.g. https://your-app.fly.dev). \
                 It prefixes stored avatar/banner URLs — leaving it unset bakes \
                 unreachable http://localhost links into the database permanently."
            );
        }
    }

    Ok(ConfigPlan {
        backfill_jwt: !jwt_ok,
        backfill_base: !base_ok,
    })
}

/// The public base URL of this server, used to build absolute `/files/<id>` URLs that
/// are persisted to the DB. `main()` guarantees it via `validate_config` (release
/// fails without it, debug backfills a localhost default), so this does not panic in a
/// normally-started server — and there is deliberately NO silent localhost fallback
/// that could bake dead URLs into the database.
pub fn public_base_url() -> String {
    std::env::var("PUBLIC_BASE_URL")
        .expect("PUBLIC_BASE_URL must be set — start via main(), which guarantees it")
}

/// Parse a comma-separated `CORS_ALLOWED_ORIGINS` value into header values, dropping
/// blank or syntactically invalid tokens. Shared by `validate_config` (which rejects a
/// value that yields no origins) and `build_app` (which builds the allowlist).
fn parse_cors_origins(raw: &str) -> Vec<HeaderValue> {
    raw.split(',')
        .filter_map(|o| {
            let o = o.trim();
            if o.is_empty() {
                None
            } else {
                o.parse().ok()
            }
        })
        .collect()
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

/// Readiness probe — actually queries the database, so the platform health check fails
/// (diverting traffic / restarting the machine) when the DB is wedged, not merely when
/// the process is up.
async fn health(State(state): State<AppState>) -> Result<&'static str, StatusCode> {
    match sqlx::query("SELECT 1").execute(&state.db).await {
        Ok(_) => Ok("ok"),
        Err(e) => {
            tracing::error!(error = %e, "health check failed — database unreachable");
            Err(StatusCode::SERVICE_UNAVAILABLE)
        }
    }
}

/// Assemble the full application router with the production middleware stack
/// (security headers, permissive CORS, 16 MiB default body limit). The returned
/// `Router` still needs connect-info wired in by the caller via
/// `into_make_service_with_connect_info::<SocketAddr>()` so IP-based rate limiting
/// sees the real peer address.
pub fn build_app(state: AppState) -> Router {
    // CORS: locked down to an explicit allowlist when `CORS_ALLOWED_ORIGINS` is set
    // (comma-separated, e.g. `tauri://localhost,https://tauri.localhost` for the
    // desktop app). Left permissive by default so dev and the bearer-token desktop
    // client aren't broken — auth is via the Authorization header, not cookies, so a
    // browser can't ride an ambient session cross-origin. Tighten this before a
    // cookie-based session move.
    let cors = match std::env::var("CORS_ALLOWED_ORIGINS") {
        Ok(raw) if !raw.trim().is_empty() => CorsLayer::new()
            .allow_origin(parse_cors_origins(&raw))
            .allow_methods(Any)
            .allow_headers(Any),
        _ => CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(Any)
            .allow_headers(Any),
    };

    // The Instant-Servers edge router needs the DB; clone state before it's moved in.
    let router_state = state.clone();

    Router::new()
        .nest("/api/v1", api::router())
        .route("/gateway", get(gateway::ws_handler))
        .route("/files/{id}", get(api::files::serve_file))
        // Readiness probe for the platform load balancer — touches the DB (Fly check).
        .route("/healthz", get(health))
        .with_state(state)
        .layer(axum::middleware::from_fn(security_headers))
        .layer(cors)
        // 16 MiB default for JSON/avatar/emoji; the /upload route overrides to 2 GiB.
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
        // Outermost: route `<sub>.ohiyo.gg` straight to its provisioned machine via
        // fly-replay, before any normal handling. Passthrough for every other Host.
        .layer(axum::middleware::from_fn_with_state(
            router_state,
            instance_router::instance_router,
        ))
}

#[cfg(test)]
mod config_tests {
    use super::*;

    const STRONG: &str = "0123456789abcdef0123456789abcdef"; // 32 chars
    const URL: &str = "https://example.com";

    #[test]
    fn release_rejects_missing_or_weak_jwt_secret() {
        assert!(plan_config(None, Some(URL), true).is_err());
        assert!(plan_config(Some("short"), Some(URL), true).is_err());
        assert!(plan_config(Some("   "), Some(URL), true).is_err());
    }

    #[test]
    fn release_rejects_missing_public_base_url() {
        assert!(plan_config(Some(STRONG), None, true).is_err());
        assert!(plan_config(Some(STRONG), Some("  "), true).is_err());
    }

    #[test]
    fn release_accepts_strong_config_without_backfill() {
        let plan = plan_config(Some(STRONG), Some(URL), true).expect("valid prod config");
        assert!(!plan.backfill_jwt && !plan.backfill_base);
    }

    #[test]
    fn debug_backfills_instead_of_failing() {
        let plan = plan_config(None, None, false).expect("dev never fails");
        assert!(plan.backfill_jwt && plan.backfill_base);
    }

    #[test]
    fn jwt_secret_length_boundary_is_enforced() {
        let len31 = "0123456789abcdef0123456789abcde"; // 31 chars
        let len32 = "0123456789abcdef0123456789abcdef"; // 32 chars
        assert_eq!(len31.len(), 31);
        assert_eq!(len32.len(), 32);
        assert!(
            plan_config(Some(len31), Some(URL), true).is_err(),
            "31 chars is below the minimum and must be rejected"
        );
        assert!(
            plan_config(Some(len32), Some(URL), true).is_ok(),
            "exactly 32 chars must be accepted"
        );
    }

    #[test]
    fn cors_origins_parse_valid_and_drop_garbage() {
        assert!(parse_cors_origins("").is_empty());
        assert!(parse_cors_origins("  ,  ").is_empty());
        assert!(
            parse_cors_origins("\u{0}bad").is_empty(),
            "control characters are not valid header values"
        );
        let ok = parse_cors_origins("tauri://localhost, https://tauri.localhost");
        assert_eq!(ok.len(), 2);
    }
}
