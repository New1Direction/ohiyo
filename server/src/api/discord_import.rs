use axum::{
    extract::{Multipart, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

use crate::{
    auth::AuthUser,
    gateway::broadcast_to_server,
    import::{
        self,
        discrawl::{self, DiscrawlPreview, DiscrawlReadOptions},
        model::{HistoryWindow, ImportOptions},
        report::ImportReport,
    },
    types::{new_id, GatewayEvent, ServerWithChannels},
    AppState,
};

const IMPORT_UPLOAD_DIR: &str = "import-uploads/discord";
const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";
const DEFAULT_MAX_DISCRAWL_DB_UPLOAD_BYTES: i64 = 2 * 1024 * 1024 * 1024; // 2 GiB

#[derive(Debug, Deserialize)]
pub struct DiscrawlArchiveBody {
    /// Path on the server host to Discrawl's SQLite archive. This endpoint is gated
    /// behind `OHIYO_ENABLE_LOCAL_DISCRAWL_IMPORT=1` because arbitrary host paths are
    /// appropriate for local/admin import tooling, not public multi-tenant traffic.
    pub db_path: String,
    /// Optional base directory for downloaded Discrawl media. Relative
    /// `message_attachments.media_path` values are resolved against this directory.
    pub media_root: Option<String>,
    /// Optional Discord guild snowflake. If omitted, the first non-`@me` guild is used.
    pub guild_id: Option<String>,
    pub history: Option<HistoryWindow>,
}

#[derive(Debug, Serialize)]
pub struct DiscrawlImportResponse {
    pub server: ServerWithChannels,
    pub report: ImportReport,
}

#[derive(Debug, Serialize)]
pub struct DiscrawlImportCapability {
    pub enabled: bool,
    pub mode: &'static str,
    pub message: &'static str,
}

#[derive(Debug, Serialize)]
pub struct DiscrawlArchiveUploadResponse {
    pub db_path: String,
    pub filename: String,
    pub size_bytes: i64,
}

pub async fn discrawl_import_capability(
    _auth: AuthUser,
) -> Result<Json<DiscrawlImportCapability>, (StatusCode, String)> {
    let enabled = local_discrawl_import_enabled();
    Ok(Json(DiscrawlImportCapability {
        enabled,
        mode: "local_discrawl_archive",
        message: if enabled {
            "This home can import a local Discrawl SQLite archive."
        } else {
            "Local Discrawl archive import is disabled on this home. Set OHIYO_ENABLE_LOCAL_DISCRAWL_IMPORT=1 on the server to enable it."
        },
    }))
}

pub async fn upload_discrawl_archive(
    auth: AuthUser,
    mut multipart: Multipart,
) -> Result<Json<DiscrawlArchiveUploadResponse>, (StatusCode, String)> {
    require_local_discrawl_import_enabled()?;
    tokio::fs::create_dir_all(IMPORT_UPLOAD_DIR)
        .await
        .map_err(crate::api::error::internal)?;

    let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
    else {
        return Err((StatusCode::BAD_REQUEST, "archive file required".into()));
    };

    let filename = field
        .file_name()
        .map(str::to_owned)
        .unwrap_or_else(|| "discrawl.db".to_owned());
    validate_db_filename(&filename)?;

    let safe_filename = safe_filename(&filename);
    let tmp_path = PathBuf::from(IMPORT_UPLOAD_DIR).join(format!("tmp-{}", new_id()));
    let final_path = PathBuf::from(IMPORT_UPLOAD_DIR).join(format!(
        "{}-{}-{}",
        safe_filename_stem(&auth.0),
        new_id(),
        safe_filename
    ));
    let mut tmp_file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(crate::api::error::internal)?;

    let max_bytes = max_discrawl_db_upload_bytes();
    let mut size_bytes: i64 = 0;
    let mut header = Vec::with_capacity(SQLITE_MAGIC.len());

    while let Some(chunk) = field
        .chunk()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
    {
        size_bytes += chunk.len() as i64;
        if size_bytes > max_bytes {
            cleanup_tmp(&tmp_path).await;
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                "Discrawl archive upload is too large".into(),
            ));
        }
        if header.len() < SQLITE_MAGIC.len() {
            let take = (SQLITE_MAGIC.len() - header.len()).min(chunk.len());
            header.extend_from_slice(&chunk[..take]);
        }
        tmp_file
            .write_all(&chunk)
            .await
            .map_err(crate::api::error::internal)?;
    }
    tmp_file.flush().await.ok();
    drop(tmp_file);

    if header.as_slice() != SQLITE_MAGIC {
        cleanup_tmp(&tmp_path).await;
        return Err((
            StatusCode::BAD_REQUEST,
            "uploaded file is not a SQLite database".into(),
        ));
    }

    tokio::fs::rename(&tmp_path, &final_path)
        .await
        .map_err(crate::api::error::internal)?;

    Ok(Json(DiscrawlArchiveUploadResponse {
        db_path: final_path.to_string_lossy().to_string(),
        filename,
        size_bytes,
    }))
}

pub async fn preview_discrawl_import(
    _auth: AuthUser,
    State(_state): State<AppState>,
    Json(body): Json<DiscrawlArchiveBody>,
) -> Result<Json<DiscrawlPreview>, (StatusCode, String)> {
    require_local_discrawl_import_enabled()?;
    validate_db_path(&body.db_path)?;
    let preview = discrawl::preview(&body.db_path, read_opts(&body))
        .await
        .map_err(crate::api::error::internal)?;
    Ok(Json(preview))
}

pub async fn run_discrawl_import(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<DiscrawlArchiveBody>,
) -> Result<Json<DiscrawlImportResponse>, (StatusCode, String)> {
    require_local_discrawl_import_enabled()?;
    validate_db_path(&body.db_path)?;
    let guild = discrawl::read_source_guild(&body.db_path, read_opts(&body))
        .await
        .map_err(crate::api::error::internal)?;
    let opts = ImportOptions {
        history: body.history.unwrap_or(HistoryWindow::All),
    };
    let (server_id, report) = import::run_import(&state.db, &auth.0, &guild, opts)
        .await
        .map_err(crate::api::error::internal)?;
    let server = crate::api::servers::fetch_full(&server_id, &state).await?;
    broadcast_to_server(
        &state,
        &server.server.id,
        &GatewayEvent::ServerCreate(server.clone()),
    )
    .await;
    Ok(Json(DiscrawlImportResponse { server, report }))
}

fn read_opts(body: &DiscrawlArchiveBody) -> DiscrawlReadOptions {
    DiscrawlReadOptions {
        guild_id: body.guild_id.clone(),
        media_root: body.media_root.as_ref().map(PathBuf::from),
    }
}

fn max_discrawl_db_upload_bytes() -> i64 {
    std::env::var("OHIYO_MAX_DISCRAWL_DB_UPLOAD_BYTES")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(DEFAULT_MAX_DISCRAWL_DB_UPLOAD_BYTES)
}

async fn cleanup_tmp(path: &Path) {
    tokio::fs::remove_file(path).await.ok();
}

fn safe_filename(name: &str) -> String {
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.trim_matches('_').is_empty() {
        "discrawl.db".to_owned()
    } else {
        safe
    }
}

fn safe_filename_stem(name: &str) -> String {
    safe_filename(name)
        .chars()
        .take(24)
        .collect::<String>()
        .trim_matches('_')
        .to_owned()
}

fn validate_db_filename(filename: &str) -> Result<(), (StatusCode, String)> {
    if filename.ends_with(".db") || filename.ends_with(".sqlite") || filename.ends_with(".sqlite3")
    {
        Ok(())
    } else {
        Err((
            StatusCode::BAD_REQUEST,
            "archive must be a SQLite file (.db/.sqlite/.sqlite3)".into(),
        ))
    }
}

fn local_discrawl_import_enabled() -> bool {
    matches!(
        std::env::var("OHIYO_ENABLE_LOCAL_DISCRAWL_IMPORT"),
        Ok(v) if v == "1" || v.eq_ignore_ascii_case("true")
    )
}

fn require_local_discrawl_import_enabled() -> Result<(), (StatusCode, String)> {
    if local_discrawl_import_enabled() {
        Ok(())
    } else {
        Err((
            StatusCode::FORBIDDEN,
            "local Discrawl archive import is disabled on this server".into(),
        ))
    }
}

fn validate_db_path(path: &str) -> Result<(), (StatusCode, String)> {
    if path.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "db_path required".into()));
    }
    if !path.ends_with(".db") && !path.ends_with(".sqlite") && !path.ends_with(".sqlite3") {
        return Err((
            StatusCode::BAD_REQUEST,
            "db_path must point to a SQLite archive (.db/.sqlite/.sqlite3)".into(),
        ));
    }
    Ok(())
}
