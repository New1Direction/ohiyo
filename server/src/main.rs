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

    let app = build_app(state);

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
