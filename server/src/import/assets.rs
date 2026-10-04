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
use std::time::Duration;
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
    let (content_type, bytes) = fetch_asset(url).await?;

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

/// How long one asset download may take.
const ASSET_FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// Download an archive-supplied image URL: its content type and bytes.
async fn fetch_asset(url: &str) -> Result<(String, Vec<u8>)> {
    let client = pinned_asset_client(url).await?;
    fetch_image(&client, url).await
}

/// A client for `url` that connects only to an address the link-preview SSRF guard
/// accepted as public, pinned so a second DNS answer can't swap in an internal one.
async fn pinned_asset_client(url: &str) -> Result<reqwest::Client> {
    let (host, _port, addrs) = crate::api::og::resolve_public_addrs(url)
        .await
        .with_context(|| format!("asset URL is not on a public address: {url}"))?;
    let addr = *addrs.first().context("asset host has no address")?;
    Ok(asset_client_builder()
        .resolve_to_addrs(&host, &[addr])
        .build()?)
}

/// Bounded in time, and never follows a redirect (which could lead off the checked
/// address).
fn asset_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .timeout(ASSET_FETCH_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
}

/// GET `url` with `client`; the image's content type and bytes. A redirect or error
/// status fails, and the body is read only up to the cap.
async fn fetch_image(client: &reqwest::Client, url: &str) -> Result<(String, Vec<u8>)> {
    let mut response = client
        .get(url)
        .send()
        .await
        .with_context(|| format!("download asset {url}"))?;
    if !response.status().is_success() {
        anyhow::bail!("download asset {url}: status {}", response.status());
    }

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

    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > MAX_IMPORTED_ASSET_BYTES {
            anyhow::bail!("asset exceeds 10 MiB cap");
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((content_type, bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// How a loopback test server answers.
    #[derive(Clone, Copy)]
    enum Reply {
        /// A small PNG at `/landed`; any other path redirects there.
        RedirectThenImage,
        /// Nothing, ever.
        Stall,
        /// An image body one byte over the cap, then the connection stays open.
        OversizedThenStall,
    }

    async fn loopback_server(reply: Reply) -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..n]).to_string();
                    match reply {
                        Reply::Stall => {}
                        Reply::RedirectThenImage if request.contains(" /landed ") => {
                            let head = "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: 4\r\nConnection: close\r\n\r\n";
                            let _ = socket.write_all(head.as_bytes()).await;
                            let _ = socket.write_all(b"\x89PNG").await;
                            return;
                        }
                        Reply::RedirectThenImage => {
                            let head = "HTTP/1.1 302 Found\r\nLocation: /landed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
                            let _ = socket.write_all(head.as_bytes()).await;
                            return;
                        }
                        Reply::OversizedThenStall => {
                            // No Content-Length: the body runs until the connection closes.
                            let head = "HTTP/1.1 200 OK\r\nContent-Type: image/png\r\n\r\n";
                            let _ = socket.write_all(head.as_bytes()).await;
                            let body = vec![0u8; MAX_IMPORTED_ASSET_BYTES + 1];
                            let _ = socket.write_all(&body).await;
                        }
                    }
                    std::future::pending::<()>().await;
                });
            }
        });
        addr
    }

    #[tokio::test]
    async fn archive_urls_on_internal_addresses_are_not_fetched() {
        let addr = loopback_server(Reply::RedirectThenImage).await;
        let fetched = fetch_asset(&format!("http://{addr}/landed")).await;
        assert!(fetched.is_err(), "a loopback asset URL must be refused");
    }

    #[tokio::test]
    async fn asset_fetches_do_not_follow_redirects() {
        let addr = loopback_server(Reply::RedirectThenImage).await;
        let client = asset_client_builder().build().unwrap();
        let err = fetch_image(&client, &format!("http://{addr}/icon.png"))
            .await
            .expect_err("a redirect is not followed");
        assert!(err.to_string().contains("302"), "{err:#}");
    }

    #[tokio::test]
    async fn asset_fetches_give_up_after_ten_seconds() {
        let addr = loopback_server(Reply::Stall).await;
        let client = asset_client_builder().build().unwrap();
        let started = Instant::now();
        let outcome = tokio::time::timeout(
            Duration::from_secs(15),
            fetch_image(&client, &format!("http://{addr}/icon.png")),
        )
        .await
        .expect("the fetch must time out on its own");
        assert!(outcome.is_err());
        assert!(started.elapsed() >= Duration::from_secs(10));
    }

    #[tokio::test]
    async fn asset_bodies_stop_being_read_past_10_mib() {
        let addr = loopback_server(Reply::OversizedThenStall).await;
        let client = asset_client_builder().build().unwrap();
        let outcome = tokio::time::timeout(
            Duration::from_secs(5),
            fetch_image(&client, &format!("http://{addr}/icon.png")),
        )
        .await
        .expect("an oversized body is refused without waiting for its end");
        let err = outcome.expect_err("over the cap");
        assert!(err.to_string().contains("10 MiB"), "{err:#}");
    }
}
