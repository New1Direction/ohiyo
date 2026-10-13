//! Message search in a space, read like Discord's: `from:`, `mentions:`, `in:`, `has:`,
//! `before:`/`after:`/`during:`, `pinned:` and the words left over (see
//! [`crate::api::search_query`]), every one of which a result must match.
//!
//! It only ever looks in channels the searcher can read, worked out once per search, and
//! never in DMs or group chats: those have no space and are end-to-end encrypted, so the
//! server holds only ciphertext for them. Results come newest first.
//!
//! `GET /servers/{server_id}/search?q=…&envelope=1&offset=…&limit=…&tz=…` answers with a
//! page and its total ([`SearchPage`]). Without `envelope=1` the answer is the plain list of
//! messages that older apps (desktop 0.3.x) expect.
//!
//! With Meilisearch enabled, a search of plain words with no filters asks Meilisearch for its
//! first page; anything with a filter, or a later page, is answered by SQL, which can apply
//! every filter exactly. A Meilisearch error falls back to SQL too.

use std::collections::{HashMap, HashSet};

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use sqlx::{QueryBuilder, Sqlite};

use crate::{
    api::{
        messages::build_full,
        notifications::mentions_name,
        search_query::{parse, ParsedQuery},
    },
    auth::AuthUser,
    types::{now_unix, Channel, Message, MessageWithAuthor},
    AppState,
};

type ApiError = (StatusCode, String);

/// Longest search, in characters.
const MAX_QUERY_CHARS: usize = 500;
/// Most words and values of each kind a search may use; more are ignored.
const MAX_PER_KIND: usize = 10;
/// Page size when none is asked for, and the most a page can hold.
const DEFAULT_LIMIT: i64 = 25;
const MAX_LIMIT: i64 = 50;
/// How many of the newest matches a search looks at. Pages can't reach further back, and
/// the total never counts past [`TOTAL_CAP`] anyway.
const SCAN_LIMIT: i64 = 1000;
/// Where the total stops counting ("100+").
const TOTAL_CAP: usize = 100;
/// Furthest a time zone can be from UTC, in minutes (UTC−12 to UTC+14).
const MAX_TZ_MINUTES: i64 = 14 * 60;

#[derive(Deserialize)]
pub struct SearchParams {
    pub q: String,
    #[serde(default)]
    pub limit: Option<i64>,
    #[serde(default)]
    pub offset: Option<i64>,
    /// `1` or `true`: answer with a [`SearchPage`] instead of a plain list.
    #[serde(default)]
    pub envelope: Option<String>,
    /// The searcher's time zone, in minutes behind UTC, as a browser's
    /// `Date.getTimezoneOffset()` gives it. Days in `before:`/`after:`/`during:` are theirs.
    #[serde(default)]
    pub tz: Option<i64>,
}

/// A channel a page's messages are in, named so the app can show "Rollout in #general".
#[derive(Serialize, Clone)]
pub struct SearchChannel {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub parent_name: Option<String>,
}

#[derive(Serialize)]
pub struct SearchPage {
    pub messages: Vec<MessageWithAuthor>,
    /// Matches in all, up to [`TOTAL_CAP`].
    pub total: usize,
    /// True when there are more than [`TOTAL_CAP`].
    pub total_capped: bool,
    pub offset: i64,
    pub limit: i64,
    pub channels: Vec<SearchChannel>,
}

/// GET /servers/{server_id}/search — see the module docs.
pub async fn search_messages(
    auth: AuthUser,
    Path(server_id): Path<String>,
    Query(params): Query<SearchParams>,
    State(state): State<AppState>,
) -> Result<Response, ApiError> {
    if !crate::api::servers::is_member(&state, &server_id, &auth.0).await {
        return Err((StatusCode::FORBIDDEN, "not a member of this server".into()));
    }
    if params.q.chars().count() > MAX_QUERY_CHARS {
        return Err((StatusCode::BAD_REQUEST, "that search is too long".into()));
    }
    let tz = params.tz.unwrap_or(0);
    if tz.abs() > MAX_TZ_MINUTES {
        return Err((
            StatusCode::BAD_REQUEST,
            "that time zone doesn't exist".into(),
        ));
    }
    let limit = params.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let offset = params.offset.unwrap_or(0).clamp(0, SCAN_LIMIT);
    let envelope = matches!(params.envelope.as_deref(), Some("1" | "true"));

    let mut query = parse(params.q.trim());
    for list in [
        &mut query.text,
        &mut query.from,
        &mut query.mentions,
        &mut query.in_channels,
        &mut query.has,
    ] {
        list.truncate(MAX_PER_KIND);
    }

    let page = if query == ParsedQuery::default() {
        empty_page(offset, limit)
    } else {
        let channels = searchable_channels(&state, &server_id, &auth.0, &query)
            .await
            .map_err(crate::api::error::internal)?;
        if channels.is_empty() {
            empty_page(offset, limit)
        } else {
            let meili = if query.is_text_only() && offset == 0 {
                meili_page(&state, &server_id, &auth.0, &query, &channels, limit).await?
            } else {
                None
            };
            match meili {
                Some(page) => page,
                None => sql_page(&state, &auth.0, &query, &channels, tz, offset, limit).await?,
            }
        }
    };

    Ok(if envelope {
        Json(page).into_response()
    } else {
        Json(page.messages).into_response()
    })
}

fn empty_page(offset: i64, limit: i64) -> SearchPage {
    SearchPage {
        messages: Vec::new(),
        total: 0,
        total_capped: false,
        offset,
        limit,
        channels: Vec::new(),
    }
}

/// The space's channels this person can read and the search may look in: every channel
/// they can view (by its permissions and overwrites), with each thread following its
/// parent channel, narrowed to the `in:` channels and their threads when there are any.
async fn searchable_channels(
    state: &AppState,
    server_id: &str,
    user_id: &str,
    query: &ParsedQuery,
) -> Result<HashMap<String, SearchChannel>, sqlx::Error> {
    let top: Vec<Channel> =
        sqlx::query_as("SELECT * FROM channels WHERE server_id = ? AND parent_id IS NULL")
            .bind(server_id)
            .fetch_all(&state.db)
            .await?;
    let viewable = crate::api::roles::viewable_channels(state, server_id, user_id, top).await?;
    let wanted: HashSet<&str> = query.in_channels.iter().map(String::as_str).collect();
    let mut out: HashMap<String, SearchChannel> = viewable
        .into_iter()
        .filter(|c| wanted.is_empty() || wanted.contains(c.name.to_lowercase().as_str()))
        .map(|c| {
            (
                c.id.clone(),
                SearchChannel {
                    id: c.id,
                    name: c.name,
                    parent_id: None,
                    parent_name: None,
                },
            )
        })
        .collect();
    let threads: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT id, name, parent_id FROM channels WHERE server_id = ? AND parent_id IS NOT NULL",
    )
    .bind(server_id)
    .fetch_all(&state.db)
    .await?;
    for (id, name, parent_id) in threads {
        let Some(parent) = out.get(&parent_id) else {
            continue;
        };
        let thread = SearchChannel {
            id: id.clone(),
            name,
            parent_name: Some(parent.name.clone()),
            parent_id: Some(parent_id),
        };
        out.insert(id, thread);
    }
    Ok(out)
}

/// Unix time at the start of `day` (`YYYY-MM-DD`) in a time zone `tz` minutes behind UTC,
/// shifted by `days`.
fn day_start(day: &str, tz: i64, days: i64) -> Option<i64> {
    let date = chrono::NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
    let date = date.checked_add_signed(chrono::Duration::days(days))?;
    Some(date.and_hms_opt(0, 0, 0)?.and_utc().timestamp() + tz * 60)
}

/// `value` with LIKE's wildcards escaped (for `ESCAPE '\'`).
fn like_escaped(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// True when an attachment of the message (either JSON shape: native sends store objects
/// with a `content_type`, Discord imports store bare file ids) is of `prefix` (`image/` …).
const ATTACHMENT_OF_KIND: &str = "json_valid(m.attachments) AND EXISTS (
      SELECT 1 FROM json_each(m.attachments) a
      LEFT JOIN files f ON f.id = (CASE WHEN a.type = 'text' THEN a.value
                                       ELSE json_extract(a.value, '$.id') END)
      WHERE COALESCE(CASE WHEN a.type = 'object' THEN json_extract(a.value, '$.content_type') END,
                     f.content_type) LIKE ";

/// Every filter, applied in SQL over the searchable channels; `mentions:` is narrowed in SQL
/// and then checked exactly with the mention rule. Looks at the newest [`SCAN_LIMIT`] matches.
async fn sql_page(
    state: &AppState,
    viewer: &str,
    query: &ParsedQuery,
    channels: &HashMap<String, SearchChannel>,
    tz: i64,
    offset: i64,
    limit: i64,
) -> Result<SearchPage, ApiError> {
    let mut qb: QueryBuilder<Sqlite> =
        QueryBuilder::new("SELECT m.id, m.content FROM messages m WHERE m.channel_id IN (");
    {
        let mut ids = qb.separated(", ");
        for id in channels.keys() {
            ids.push_bind(id.clone());
        }
    }
    qb.push(") AND (m.expires_at IS NULL OR m.expires_at > ")
        .push_bind(now_unix())
        .push(")");
    for word in &query.text {
        qb.push(" AND m.content LIKE ")
            .push_bind(format!("%{}%", like_escaped(word)))
            .push(" ESCAPE '\\'");
    }
    if !query.from.is_empty() {
        qb.push(" AND m.author_id IN (SELECT id FROM users WHERE lower(username) IN (");
        {
            let mut names = qb.separated(", ");
            for name in &query.from {
                names.push_bind(name.clone());
            }
        }
        qb.push(") OR lower(display_name) IN (");
        {
            let mut names = qb.separated(", ");
            for name in &query.from {
                names.push_bind(name.clone());
            }
        }
        qb.push("))");
    }
    for name in &query.mentions {
        qb.push(" AND m.content LIKE ")
            .push_bind(format!("%@{}%", like_escaped(name)))
            .push(" ESCAPE '\\'");
    }
    for kind in &query.has {
        match kind.as_str() {
            "link" => {
                qb.push(" AND (m.content LIKE '%http://%' OR m.content LIKE '%https://%')");
            }
            "file" => {
                qb.push(
                    " AND m.attachments IS NOT NULL AND m.attachments NOT IN ('', '[]', 'null')",
                );
            }
            "image" | "video" => {
                qb.push(" AND ")
                    .push(ATTACHMENT_OF_KIND)
                    .push_bind(format!("{kind}/%"))
                    .push(")");
            }
            "embed" => {
                qb.push(" AND m.embeds IS NOT NULL AND m.embeds NOT IN ('', '[]', 'null')");
            }
            _ => {}
        }
    }
    let day = |d: &Option<String>, shift: i64| d.as_deref().and_then(|d| day_start(d, tz, shift));
    if let Some(at) = day(&query.before, 0) {
        qb.push(" AND m.created_at < ").push_bind(at);
    }
    if let Some(at) = day(&query.after, 1) {
        qb.push(" AND m.created_at >= ").push_bind(at);
    }
    if let (Some(from), Some(to)) = (day(&query.during, 0), day(&query.during, 1)) {
        qb.push(" AND m.created_at >= ")
            .push_bind(from)
            .push(" AND m.created_at < ")
            .push_bind(to);
    }
    if let Some(pinned) = query.pinned {
        qb.push(" AND m.pinned = ").push_bind(i64::from(pinned));
    }
    qb.push(" ORDER BY m.created_at DESC, m.rowid DESC LIMIT ")
        .push_bind(SCAN_LIMIT);

    let rows: Vec<(String, String)> = qb
        .build_query_as()
        .fetch_all(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    let matches: Vec<String> = rows
        .into_iter()
        .filter(|(_, content)| {
            query
                .mentions
                .iter()
                .all(|name| mentions_name(content, name))
        })
        .map(|(id, _)| id)
        .collect();

    let page_ids: Vec<&String> = matches
        .iter()
        .skip(offset as usize)
        .take(limit as usize)
        .collect();
    let mut messages = Vec::with_capacity(page_ids.len());
    for id in page_ids {
        let msg: Option<Message> = sqlx::query_as("SELECT * FROM messages WHERE id = ?")
            .bind(id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
        if let Some(msg) = msg {
            messages.push(build_full(state, msg, viewer).await?);
        }
    }
    Ok(SearchPage {
        channels: channels_of(&messages, channels),
        total: matches.len().min(TOTAL_CAP),
        total_capped: matches.len() > TOTAL_CAP,
        messages,
        offset,
        limit,
    })
}

/// The first page of a plain-words search from Meilisearch, kept to the searchable
/// channels and re-read from the database (an index entry can be stale). None when
/// Meilisearch is off or failed, so SQL answers instead.
async fn meili_page(
    state: &AppState,
    server_id: &str,
    viewer: &str,
    query: &ParsedQuery,
    channels: &HashMap<String, SearchChannel>,
    limit: i64,
) -> Result<Option<SearchPage>, ApiError> {
    if !crate::search::search_enabled() {
        return Ok(None);
    }
    let words = query.text.join(" ");
    let Some(ids) = crate::search::search_ids(server_id, &words, limit as usize).await else {
        return Ok(None);
    };
    let mut messages = Vec::with_capacity(ids.len());
    for id in ids {
        let msg: Option<Message> = sqlx::query_as("SELECT * FROM messages WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
        if let Some(msg) = msg.filter(|m| channels.contains_key(&m.channel_id)) {
            messages.push(build_full(state, msg, viewer).await?);
        }
    }
    Ok(Some(SearchPage {
        channels: channels_of(&messages, channels),
        total: messages.len(),
        total_capped: false,
        messages,
        offset: 0,
        limit,
    }))
}

/// The channels `messages` are in, each once, in the order they first appear.
fn channels_of(
    messages: &[MessageWithAuthor],
    channels: &HashMap<String, SearchChannel>,
) -> Vec<SearchChannel> {
    let mut seen = HashSet::new();
    messages
        .iter()
        .filter(|m| seen.insert(m.channel_id.clone()))
        .filter_map(|m| channels.get(&m.channel_id).cloned())
        .collect()
}
