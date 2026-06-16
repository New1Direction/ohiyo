use std::net::SocketAddr;

use server::{api, build_app, build_state, db, search, validate_config};

// ── Entry point ───────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            std::env::var("RUST_LOG").unwrap_or_else(|_| "server=info,tower_http=info".to_owned()),
        )
        .init();

    // Fail fast on misconfiguration before binding (release builds only — dev gets
    // convenient localhost defaults). See validate_config for the guarantees.
    validate_config()?;

    let database_url =
        std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite:kikkacord.db".to_owned());

    let db = db::connect(&database_url).await?;
    tracing::info!("Database connected");

    // Bring up the Meilisearch index if full-text search is enabled (logs + continues
    // on failure so an unreachable search service never blocks boot).
    if search::search_enabled() {
        search::ensure_index().await;
    }

    let state = build_state(db);

    // Disappearing messages, the dead-man's switch, and link-token GC run on a periodic
    // sweeper. Each iteration is wrapped in catch_unwind so a panic in one sweep is
    // logged and the loop survives to the next tick — a background task that silently
    // dies would let ciphertext, lapsed accounts, and stale codes accumulate forever.
    {
        use futures_util::FutureExt;
        let sweep_state = state.clone();
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(20)).await;
                let iteration = std::panic::AssertUnwindSafe(async {
                    api::messages::sweep_expired(&sweep_state).await;
                    // Account-level dead-man's switch: wipe data for users gone too long.
                    api::users::sweep_deadman(&sweep_state).await;
                    // Drop expired device-link codes so the table can't grow unbounded.
                    api::auth::sweep_link_tokens(&sweep_state).await;
                });
                if iteration.catch_unwind().await.is_err() {
                    tracing::error!("a background sweep panicked — continuing the loop");
                }
            }
        });
    }

    let app = build_app(state);

    let addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:3000".to_owned());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("Kikkacord server listening on {addr}");
    // Connect-info lets auth handlers rate-limit by client IP. Graceful shutdown lets
    // in-flight requests drain on SIGTERM (Fly sends it on deploy/stop) or Ctrl-C,
    // instead of being cut off mid-flight.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;

    Ok(())
}

/// Resolve when the process receives SIGTERM or Ctrl-C, so the server can stop
/// accepting new connections and let outstanding requests finish.
async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("install Ctrl-C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("install SIGTERM handler")
            .recv()
            .await;
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    tracing::info!("shutdown signal received — draining connections");
}
