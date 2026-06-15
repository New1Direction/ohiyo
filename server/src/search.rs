//! Meilisearch full-text search over its REST API — no SDK dependency, just the
//! same `reqwest` the rest of the server uses. Everything is gated behind
//! `MEILISEARCH_ENABLED` (+ a configured URL); when off, the search endpoint
//! falls back to a SQL `LIKE` query and the index hooks no-op.

use serde::Serialize;
use std::sync::OnceLock;
use std::time::Duration;

static HTTP: OnceLock<reqwest::Client> = OnceLock::new();

fn http() -> &'static reqwest::Client {
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .build()
            .expect("meili http client")
    })
}

/// `(base_url, api_key)` when a Meilisearch URL is configured.
fn config() -> Option<(String, String)> {
    let url = std::env::var("MEILISEARCH_URL").ok()?;
    if url.trim().is_empty() {
        return None;
    }
    let key = std::env::var("MEILISEARCH_API_KEY").unwrap_or_default();
    Some((url.trim_end_matches('/').to_owned(), key))
}

/// True only when explicitly enabled AND a URL is configured.
pub fn search_enabled() -> bool {
    std::env::var("MEILISEARCH_ENABLED")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false)
        && config().is_some()
}

/// One indexed message. `server_id` is denormalised so a single filter scopes a
/// whole server's search; it's `None` for DM channels (which this endpoint never
/// searches).
#[derive(Serialize)]
pub struct MessageDoc {
    pub id: String,
    pub channel_id: String,
    pub server_id: Option<String>,
    pub author_id: String,
    pub author_name: String,
    pub content: String,
    pub created_at: i64,
}

/// Create the `messages` index and apply attribute settings. Idempotent; logs and
/// returns on failure so an unreachable Meilisearch never blocks boot.
pub async fn ensure_index() {
    let Some((url, key)) = config() else {
        return;
    };
    if let Err(e) = http()
        .post(format!("{url}/indexes"))
        .bearer_auth(&key)
        .json(&serde_json::json!({ "uid": "messages", "primaryKey": "id" }))
        .send()
        .await
    {
        tracing::warn!("meili create-index failed: {e}");
        return;
    }
    match http()
        .patch(format!("{url}/indexes/messages/settings"))
        .bearer_auth(&key)
        .json(&serde_json::json!({
            "filterableAttributes": ["channel_id", "server_id", "author_id"],
            "searchableAttributes": ["content", "author_name"],
            "sortableAttributes": ["created_at"],
        }))
        .send()
        .await
    {
        Ok(_) => tracing::info!("meilisearch index 'messages' ready"),
        Err(e) => tracing::warn!("meili settings failed: {e}"),
    }
}

/// Upsert a message document. Fire-and-forget — callers `tokio::spawn` this.
pub async fn index_message(doc: MessageDoc) {
    let Some((url, key)) = config() else {
        return;
    };
    if let Err(e) = http()
        .post(format!("{url}/indexes/messages/documents"))
        .bearer_auth(&key)
        .json(&[doc])
        .send()
        .await
    {
        tracing::warn!("meili index failed: {e}");
    }
}

/// Remove a message document by id. Fire-and-forget.
pub async fn delete_message(id: String) {
    let Some((url, key)) = config() else {
        return;
    };
    if let Err(e) = http()
        .delete(format!("{url}/indexes/messages/documents/{id}"))
        .bearer_auth(&key)
        .send()
        .await
    {
        tracing::warn!("meili delete failed: {e}");
    }
}

/// Search within one server, returning matching message IDs by relevance. Returns
/// `None` on any transport/parse error so the caller can fall back to SQL.
pub async fn search_ids(server_id: &str, q: &str, limit: usize) -> Option<Vec<String>> {
    let (url, key) = config()?;
    // server_id is a server-issued UUID; escape quotes defensively for the filter DSL.
    let filter = format!("server_id = '{}'", server_id.replace('\'', "\\'"));
    let res = http()
        .post(format!("{url}/indexes/messages/search"))
        .bearer_auth(&key)
        .json(&serde_json::json!({
            "q": q,
            "filter": filter,
            "limit": limit,
            "attributesToRetrieve": ["id"],
        }))
        .send()
        .await
        .ok()?;
    let body: serde_json::Value = res.json().await.ok()?;
    let hits = body.get("hits")?.as_array()?;
    Some(
        hits.iter()
            .filter_map(|h| h.get("id").and_then(|v| v.as_str()).map(str::to_owned))
            .collect(),
    )
}
