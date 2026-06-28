//! Remote asset ingestion for one-command community migrations.
//!
//! Discord templates can expose familiar assets (guild icon, custom emoji). Pull them
//! into Ohiyo's existing `files` table so the migrated space does not depend on Discord
//! CDN URLs staying valid.

use anyhow::{Context, Result};
use reqwest::header::CONTENT_TYPE;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;

use crate::types::{new_id, now_unix};

const UPLOAD_DIR: &str = "uploads";
const MAX_IMPORTED_ASSET_BYTES: usize = 10 * 1024 * 1024;

#[derive(Debug, Clone)]
pub struct ImportedAsset {
    pub file_id: String,
    pub content_type: String,
}

pub async fn download_image_to_file(
    db: &SqlitePool,
    uploader_id: &str,
    url: &str,
    filename: &str,
) -> Result<ImportedAsset> {
    let response = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .with_context(|| format!("download asset {url}"))?
        .error_for_status()
        .with_context(|| format!("download asset {url}"))?;

    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .trim()
        .to_ascii_lowercase();
    if !matches!(
        content_type.as_str(),
        "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif"
    ) {
        anyhow::bail!("asset is not a supported image type: {content_type}");
    }

    let bytes = response.bytes().await?;
    if bytes.len() > MAX_IMPORTED_ASSET_BYTES {
        anyhow::bail!("asset exceeds 10 MiB cap");
    }

    tokio::fs::create_dir_all(UPLOAD_DIR).await?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let sha256 = format!("{:x}", hasher.finalize());

    let existing: Option<(String,)> = sqlx::query_as("SELECT id FROM files WHERE sha256 = ?")
        .bind(&sha256)
        .fetch_optional(db)
        .await?;
    if let Some((id,)) = existing {
        return Ok(ImportedAsset {
            file_id: id,
            content_type,
        });
    }

    let final_path = PathBuf::from(UPLOAD_DIR)
        .join(&sha256[..2])
        .join(&sha256[2..4])
        .join(&sha256);
    if let Some(parent) = final_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let tmp_path = PathBuf::from(UPLOAD_DIR).join(format!("tmp-{}", new_id()));
    let mut tmp_file = tokio::fs::File::create(&tmp_path).await?;
    tmp_file.write_all(&bytes).await?;
    tmp_file.flush().await.ok();
    drop(tmp_file);
    tokio::fs::rename(&tmp_path, &final_path).await?;

    let dims_path = final_path.clone();
    let (width, height) =
        match tokio::task::spawn_blocking(move || imagesize::size(&dims_path)).await {
            Ok(Ok(dim)) => (Some(dim.width as i64), Some(dim.height as i64)),
            _ => (None, None),
        };

    let file_id = new_id();
    sqlx::query(
        "INSERT INTO files (id, uploader_id, filename, content_type, size_bytes, sha256, path, created_at, width, height)
         VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(&file_id)
    .bind(uploader_id)
    .bind(filename)
    .bind(&content_type)
    .bind(i64::try_from(bytes.len()).unwrap_or(i64::MAX))
    .bind(&sha256)
    .bind(final_path.to_string_lossy().to_string())
    .bind(now_unix())
    .bind(width)
    .bind(height)
    .execute(db)
    .await?;

    Ok(ImportedAsset {
        file_id,
        content_type,
    })
}
