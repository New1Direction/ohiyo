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

use crate::{auth::AuthUser, types::{new_id, now_unix}, AppState};

const UPLOAD_DIR: &str = "uploads";

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
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

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
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        let mut hasher = Sha256::new();
        let mut size_bytes: i64 = 0;
        let mut data = field;

        while let Some(chunk) = data
            .chunk()
            .await
            .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
        {
            hasher.update(&chunk);
            size_bytes += chunk.len() as i64;
            tmp_file
                .write_all(&chunk)
                .await
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
        }
        tmp_file.flush().await.ok();

        let sha256 = format!("{:x}", hasher.finalize());

        // Check if file already exists (dedup by content hash).
        let existing: Option<(String, String, Option<i64>, Option<i64>)> = sqlx::query_as(
            "SELECT id, path, width, height FROM files WHERE sha256 = ?",
        )
        .bind(&sha256)
        .fetch_optional(&state.db)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

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
                .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

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
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

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
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT path, filename, content_type FROM files WHERE id = ?",
    )
    .bind(&id)
    .fetch_optional(&state.db)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let (path, filename, content_type) = row.ok_or((StatusCode::NOT_FOUND, "not found".into()))?;

    let file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "file missing on disk".into()))?;

    let stream = tokio_util::io::ReaderStream::new(file);
    let body = Body::from_stream(stream);

    let safe_filename: String = filename
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, content_type)
        .header(
            header::CONTENT_DISPOSITION,
            format!("inline; filename=\"{}\"", safe_filename),
        )
        .body(body)
        .unwrap())
}
