use std::net::SocketAddr;

use server::{
    api, build_app, build_state, db, search, spawn_push_dispatcher, spawn_sweeper, validate_config,
    BACKGROUND_INTERVAL,
};

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
        std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite:ohiyo.db".to_owned());

    let db = db::connect(&database_url).await?;
    tracing::info!("Database connected");

    // Bring up the Meilisearch index if full-text search is enabled (logs + continues
    // on failure so an unreachable search service never blocks boot).
    if search::search_enabled() {
        search::ensure_index().await;
    }

    // Temp files left by uploads cut off by a crash or restart are never renamed into place.
    api::files::sweep_stale_temp_files().await;

    let state = build_state(db);

    // Periodic sweeps (disappearing messages, the dead-man's switch, link-token GC) and
    // content-free push dispatch, each on its own task.
    spawn_sweeper(state.clone(), BACKGROUND_INTERVAL);
    spawn_push_dispatcher(state.clone(), BACKGROUND_INTERVAL);

    let app = build_app(state);

    let addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:3000".to_owned());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("Ohiyo server listening on {addr}");
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
