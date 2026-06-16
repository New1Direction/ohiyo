use axum::{
    body::Body,
    extract::{Multipart, Path, State},
    http::{header, StatusCode},
    response::Response,
    Json,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;

use crate::{
    auth::AuthUser,
    types::{new_id, now_unix},
    AppState,
};

const UPLOAD_DIR: &str = "uploads";

/// Default per-user cumulative upload cap (bytes). Overridable via
/// `MAX_UPLOAD_BYTES_PER_USER` so operators can size it to their volume — it stops a
/// single account from exhausting the shared disk and breaking the DB for everyone.
const DEFAULT_MAX_BYTES_PER_USER: i64 = 500 * 1024 * 1024; // 500 MiB

fn max_bytes_per_user() -> i64 {
    std::env::var("MAX_UPLOAD_BYTES_PER_USER")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(DEFAULT_MAX_BYTES_PER_USER)
}

/// Media types we are willing to serve INLINE (rendered by the browser). Everything
/// else — notably `text/html` and `image/svg+xml`, which can execute script — is forced
/// to download as an opaque octet-stream, so an uploaded file can never run as a
/// document in a user's browser. Parameters (`; charset=…`) and case are ignored.
fn is_inline_safe(content_type: &str) -> bool {
    let base = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    matches!(
        base.as_str(),
        "image/png"
            | "image/jpeg"
            | "image/gif"
            | "image/webp"
            | "image/avif"
            | "audio/mpeg"
            | "audio/ogg"
            | "audio/wav"
            | "audio/webm"
            | "audio/mp4"
            | "audio/aac"
            | "video/mp4"
            | "video/webm"
            | "video/ogg"
            | "video/quicktime"
    )
}

#[derive(Serialize)]
pub struct FileInfo {
    pub id: String,
    pub filename: String,
    pub content_type: String,
    pub size_bytes: i64,
    pub url: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

/// Upload a file — no size limit, streams directly to disk.
pub async fn upload_file(
    auth: AuthUser,
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<Vec<FileInfo>>, (StatusCode, String)> {
    tokio::fs::create_dir_all(UPLOAD_DIR)
        .await
        .map_err(crate::api::error::internal)?;

    // Per-user storage quota. `used` starts at the bytes already attributable to this
    // account and grows as new (non-deduplicated) files are committed this request.
    let quota = max_bytes_per_user();
    let mut used: i64 =
        sqlx::query_scalar("SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE uploader_id = ?")
            .bind(&auth.0)
            .fetch_one(&state.db)
            .await
            .map_err(crate::api::error::internal)?;

    let mut results = Vec::new();

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
    {
        let filename = field
            .file_name()
            .map(str::to_owned)
            .unwrap_or_else(|| "file".to_owned());
        let content_type = field
            .content_type()
            .unwrap_or("application/octet-stream")
            .to_owned();

        // Stream field bytes through SHA-256 hasher to a temp file.
        let tmp_path = PathBuf::from(UPLOAD_DIR).join(format!("tmp-{}", new_id()));
        let mut tmp_file = tokio::fs::File::create(&tmp_path)
            .await
            .map_err(crate::api::error::internal)?;

        let mut hasher = Sha256::new();
        let mut size_bytes: i64 = 0;
        let mut data = field;

        while let Some(chunk) = data
            .chunk()
            .await
            .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
        {
            size_bytes += chunk.len() as i64;
            // Abort the moment this upload would push the user over quota — so an
            // over-limit file is never fully written to disk in the first place.
            if used + size_bytes > quota {
                tmp_file.flush().await.ok();
                drop(tmp_file);
                tokio::fs::remove_file(&tmp_path).await.ok();
                return Err((
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "upload quota exceeded".into(),
                ));
            }
            hasher.update(&chunk);
            tmp_file
                .write_all(&chunk)
                .await
                .map_err(crate::api::error::internal)?;
        }
        tmp_file.flush().await.ok();

        let sha256 = format!("{:x}", hasher.finalize());

        // Check if file already exists (dedup by content hash).
        let existing: Option<(String, String, Option<i64>, Option<i64>)> =
            sqlx::query_as("SELECT id, path, width, height FROM files WHERE sha256 = ?")
                .bind(&sha256)
                .fetch_optional(&state.db)
                .await
                .map_err(crate::api::error::internal)?;

        let (file_id, final_path, width, height) = if let Some((id, path, w, h)) = existing {
            // Reuse existing — remove temp.
            tokio::fs::remove_file(&tmp_path).await.ok();
            (id, path, w, h)
        } else {
            let file_id = new_id();
            let final_path = PathBuf::from(UPLOAD_DIR)
                .join(&sha256[..2])
                .join(&sha256[2..4])
                .join(&sha256);
            if let Some(parent) = final_path.parent() {
                tokio::fs::create_dir_all(parent).await.ok();
            }
            tokio::fs::rename(&tmp_path, &final_path)
                .await
                .map_err(crate::api::error::internal)?;

            // Read image pixel dimensions (cheap header parse; None for non-images).
            let (w, h) = match imagesize::size(&final_path) {
                Ok(dim) => (Some(dim.width as i64), Some(dim.height as i64)),
                Err(_) => (None, None),
            };

            let path_str = final_path.to_string_lossy().to_string();
            sqlx::query(
                "INSERT INTO files (id, uploader_id, filename, content_type, size_bytes, sha256, path, created_at, width, height)
                 VALUES (?,?,?,?,?,?,?,?,?,?)",
            )
            .bind(&file_id)
            .bind(&auth.0)
            .bind(&filename)
            .bind(&content_type)
            .bind(size_bytes)
            .bind(&sha256)
            .bind(&path_str)
            .bind(now_unix())
            .bind(w)
            .bind(h)
            .execute(&state.db)
            .await
            .map_err(crate::api::error::internal)?;

            // Newly stored bytes count toward the user's quota (dedup hits don't).
            used += size_bytes;
            (file_id, path_str, w, h)
        };

        results.push(FileInfo {
            url: format!("/files/{}", file_id),
            id: file_id,
            filename,
            content_type,
            size_bytes,
            width,
            height,
        });

        let _ = final_path; // suppress warning
    }

    Ok(Json(results))
}

/// Serve a file by ID.
pub async fn serve_file(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Response, (StatusCode, String)> {
    let row: Option<(String, String, String)> =
        sqlx::query_as("SELECT path, filename, content_type FROM files WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;

    let (path, filename, content_type) = row.ok_or((StatusCode::NOT_FOUND, "not found".into()))?;

    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "file missing on disk".into()))?;

    let stream = tokio_util::io::ReaderStream::new(file);
    let body = Body::from_stream(stream);

    let safe_filename: String = filename
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();

    // Only render known-safe media inline; force everything else (html, svg, scripts,
    // unknown types) to download as an opaque octet-stream so an uploaded file can
    // never execute as a document. Defense-in-depth alongside the response CSP/nosniff.
    let (served_type, disposition) = if is_inline_safe(&content_type) {
        (
            content_type,
            format!("inline; filename=\"{safe_filename}\""),
        )
    } else {
        (
            "application/octet-stream".to_owned(),
            format!("attachment; filename=\"{safe_filename}\""),
        )
    };

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, served_type)
        .header(header::CONTENT_DISPOSITION, disposition)
        .body(body)
        .unwrap())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inline_safe_allows_media_and_blocks_active_content() {
        assert!(is_inline_safe("image/png"));
        assert!(is_inline_safe("image/jpeg; charset=binary"));
        assert!(is_inline_safe("VIDEO/MP4")); // case-insensitive
        assert!(is_inline_safe("audio/mpeg"));
        // Active-content types must NEVER render inline.
        assert!(!is_inline_safe("text/html"));
        assert!(!is_inline_safe("image/svg+xml"));
        assert!(!is_inline_safe("application/pdf"));
        assert!(!is_inline_safe("application/octet-stream"));
        assert!(!is_inline_safe(""));
    }
}
