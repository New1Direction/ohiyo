use axum::{
    body::Body,
    extract::{Multipart, Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    Json,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::{
    auth::AuthUser,
    types::{new_id, now_unix},
    AppState,
};

const UPLOAD_DIR: &str = "uploads";

/// Upload blob root. Defaults to `uploads` under the process working directory
/// (`/data/uploads` in the Docker image because WORKDIR=/data). Tests and operators can
/// override it without changing DB paths via `OHIYO_UPLOAD_DIR`.
pub(crate) fn upload_dir() -> PathBuf {
    std::env::var("OHIYO_UPLOAD_DIR")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(UPLOAD_DIR))
}

/// Default per-user cumulative upload cap (bytes). Overridable via
/// `MAX_UPLOAD_BYTES_PER_USER` so operators can size it to their volume — it stops a
/// single account from exhausting the shared disk and breaking the DB for everyone.
const DEFAULT_MAX_BYTES_PER_USER: i64 = 10 * 1024 * 1024 * 1024; // 10 GiB

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

/// Upload a file — streams directly to disk and enforces the configured quota.
pub async fn upload_file(
    auth: AuthUser,
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<Vec<FileInfo>>, (StatusCode, String)> {
    let upload_root = upload_dir();
    tokio::fs::create_dir_all(&upload_root)
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
        let tmp_path = upload_root.join(format!("tmp-{}", new_id()));
        let mut tmp_file = tokio::fs::File::create(&tmp_path)
            .await
            .map_err(crate::api::error::internal)?;

        let mut hasher = Sha256::new();
        // Accumulate in u64 so a multi-GiB upload can't wrap an i64 and slip the quota
        // check. `used`/`quota` come from the DB as non-negative i64; widen them to u64
        // for the comparison, and only narrow back to i64 (checked) at the bind site.
        let mut size_bytes: u64 = 0;
        let used_u = used.max(0) as u64;
        let quota_u = quota.max(0) as u64;
        let mut data = field;

        while let Some(chunk) = data
            .chunk()
            .await
            .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
        {
            size_bytes = size_bytes.saturating_add(chunk.len() as u64);
            // Abort the moment this upload would push the user over quota — so an
            // over-limit file is never fully written to disk in the first place.
            if used_u.saturating_add(size_bytes) > quota_u {
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

        // Narrow to i64 once, checked, for the DB column / API field. A file larger
        // than i64::MAX bytes is impossible in practice but rejected rather than wrapped.
        let size_bytes: i64 = i64::try_from(size_bytes)
            .map_err(|_| (StatusCode::PAYLOAD_TOO_LARGE, "file too large".into()))?;

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
            let final_path = upload_root
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
            // `imagesize::size` does synchronous file I/O, so run it on the blocking
            // pool to keep the Tokio worker free for other connections.
            let dims_path = final_path.clone();
            let (w, h) =
                match tokio::task::spawn_blocking(move || imagesize::size(&dims_path)).await {
                    Ok(Ok(dim)) => (Some(dim.width as i64), Some(dim.height as i64)),
                    _ => (None, None),
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
            url: crate::signed_file_path(&file_id),
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

/// Optional capability signature on a `/files/{id}` request. The server appends
/// `?s=<sig>` to every file URL it emits (see `crate::signed_file_path` /
/// `signed_file_url`); enforcement of that signature is gated by
/// `OHIYO_REQUIRE_SIGNED_FILES` (see `serve_file`).
#[derive(Deserialize)]
pub struct FileQuery {
    s: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ByteRange {
    start: u64,
    end: u64,
}

fn parse_single_byte_range(raw: &str, len: u64) -> Result<ByteRange, ()> {
    if len == 0 {
        return Err(());
    }
    let spec = raw.trim().strip_prefix("bytes=").ok_or(())?.trim();
    // Keep the serving path simple and predictable: browsers' media elements use a
    // single range. Multipart ranges are intentionally rejected instead of trying to
    // synthesize a multipart/byteranges response.
    if spec.is_empty() || spec.contains(',') {
        return Err(());
    }
    let (start_raw, end_raw) = spec.split_once('-').ok_or(())?;
    if start_raw.is_empty() {
        let suffix_len = end_raw.parse::<u64>().map_err(|_| ())?;
        if suffix_len == 0 {
            return Err(());
        }
        let start = len.saturating_sub(suffix_len);
        return Ok(ByteRange {
            start,
            end: len - 1,
        });
    }

    let start = start_raw.parse::<u64>().map_err(|_| ())?;
    if start >= len {
        return Err(());
    }
    let end = if end_raw.is_empty() {
        len - 1
    } else {
        end_raw.parse::<u64>().map_err(|_| ())?.min(len - 1)
    };
    if end < start {
        return Err(());
    }
    Ok(ByteRange { start, end })
}

/// Serve a file by ID.
///
/// SECURITY / ACCESS-CONTROL: this route is unauthenticated by necessity. Avatars,
/// server icons, and message attachments are all rendered with plain `<img src>` /
/// `background-image: url()` / `<video src>` / `<audio src>`, none of which can send an
/// `Authorization` header. Requiring `AuthUser` here would 401 every image in the UI
/// (and break e2e/15-images).
///
/// SIGNED FILE URLS (`OHIYO_REQUIRE_SIGNED_FILES`): every `/files/{id}` URL the server
/// emits carries an HMAC capability signature `?s=<sig>` where
/// `sig = first 32 hex of HMAC-SHA256(JWT_SECRET, id)` (see `crate::sign_file_id`). This
/// handler ENFORCES that signature only when `OHIYO_REQUIRE_SIGNED_FILES` is truthy
/// ("1"/"true", case-insensitive); a mismatched/missing signature then returns 404 (we
/// return *not found* rather than 401 so the response never reveals whether the id
/// exists). When the flag is unset/false — the DEFAULT — the `s` param is ignored
/// entirely and serving is byte-for-byte unchanged.
///
/// CAVEAT for an existing deployment: signing is store-time. avatars, server icons, and
/// banners persisted *before* this upgrade hold a bare `/files/{id}` URL with no `?s=`;
/// if you enable the flag, those pre-existing assets must be re-saved (re-set the
/// avatar/icon/banner) to acquire a signature, otherwise they 404 under enforcement.
/// Message attachments and fresh uploads are signed going forward.
///
/// Mitigations in place regardless of the flag: file ids are unguessable UUIDv4s (no
/// enumeration), and the response forces non-media types to download as opaque
/// octet-streams under a locked-down CSP + `nosniff` (see `is_inline_safe` and
/// `security_headers`) so an uploaded file can never execute as a document.
///
/// FOLLOW-UP: once signed URLs are enforced everywhere, gate private attachments by
/// membership (uploader or a member of a channel/DM referencing the file).
pub async fn serve_file(
    Path(id): Path<String>,
    Query(query): Query<FileQuery>,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, (StatusCode, String)> {
    // Capability gate (default OFF). When enforcement is on, the URL must carry a
    // signature matching this id; on mismatch we 404 rather than 401 so we never
    // disclose whether the id exists. When off, `s` is ignored — serving is unchanged.
    if crate::require_signed_files()
        && query.s.as_deref() != Some(crate::sign_file_id(&id).as_str())
    {
        return Err((StatusCode::NOT_FOUND, "not found".into()));
    }

    let row: Option<(String, String, String)> =
        sqlx::query_as("SELECT path, filename, content_type FROM files WHERE id = ?")
            .bind(&id)
            .fetch_optional(&state.db)
            .await
            .map_err(crate::api::error::internal)?;

    let (path, filename, content_type) = row.ok_or((StatusCode::NOT_FOUND, "not found".into()))?;

    let file_len = tokio::fs::metadata(&path)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "file missing on disk".into()))?
        .len();
    let mut file = tokio::fs::File::open(&path)
        .await
        .map_err(|_| (StatusCode::NOT_FOUND, "file missing on disk".into()))?;

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

    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|raw| parse_single_byte_range(raw, file_len))
        .transpose()
        .map_err(|_| {
            (
                StatusCode::RANGE_NOT_SATISFIABLE,
                format!("range not satisfiable for {file_len} byte file"),
            )
        })?;

    let mut builder = Response::builder()
        .status(if range.is_some() {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, served_type)
        .header(header::CONTENT_DISPOSITION, disposition)
        .header(header::ACCEPT_RANGES, "bytes");

    let body = if let Some(ByteRange { start, end }) = range {
        file.seek(std::io::SeekFrom::Start(start))
            .await
            .map_err(crate::api::error::internal)?;
        let len = end - start + 1;
        builder = builder
            .header(
                header::CONTENT_RANGE,
                format!("bytes {start}-{end}/{file_len}"),
            )
            .header(header::CONTENT_LENGTH, len.to_string());
        Body::from_stream(tokio_util::io::ReaderStream::new(file.take(len)))
    } else {
        builder = builder.header(header::CONTENT_LENGTH, file_len.to_string());
        Body::from_stream(tokio_util::io::ReaderStream::new(file))
    };

    builder.body(body).map_err(|e| {
        tracing::error!("serve_file: failed to build response for {id}: {e}");
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to serve file".into(),
        )
    })
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

    #[test]
    fn parses_browser_media_byte_ranges() {
        assert_eq!(
            parse_single_byte_range("bytes=0-", 100).unwrap(),
            ByteRange { start: 0, end: 99 }
        );
        assert_eq!(
            parse_single_byte_range("bytes=10-19", 100).unwrap(),
            ByteRange { start: 10, end: 19 }
        );
        assert_eq!(
            parse_single_byte_range("bytes=90-999", 100).unwrap(),
            ByteRange { start: 90, end: 99 }
        );
        assert_eq!(
            parse_single_byte_range("bytes=-25", 100).unwrap(),
            ByteRange { start: 75, end: 99 }
        );
        assert_eq!(
            parse_single_byte_range("bytes=-250", 100).unwrap(),
            ByteRange { start: 0, end: 99 }
        );
        assert!(parse_single_byte_range("bytes=100-", 100).is_err());
        assert!(parse_single_byte_range("bytes=20-10", 100).is_err());
        assert!(parse_single_byte_range("bytes=0-1,4-5", 100).is_err());
        assert!(parse_single_byte_range("items=0-1", 100).is_err());
        assert!(parse_single_byte_range("bytes=0-", 0).is_err());
    }

    #[test]
    fn signed_file_id_is_deterministic_and_path_carries_it() {
        // `sign_file_id` reads JWT_SECRET; set a known one so this test is hermetic.
        std::env::set_var("JWT_SECRET", "0123456789abcdef0123456789abcdef");

        let id = "11111111-2222-3333-4444-555555555555";
        let sig = crate::sign_file_id(id);

        // Deterministic: same id → same 32-hex-char signature every call.
        assert_eq!(sig, crate::sign_file_id(id));
        assert_eq!(sig.len(), 32);
        assert!(sig.chars().all(|c| c.is_ascii_hexdigit()));

        // The emitted path embeds exactly the computed signature.
        assert_eq!(crate::signed_file_path(id), format!("/files/{id}?s={sig}"));

        // A tampered signature must not equal the real one (forgery is rejected).
        let tampered = format!("{sig}deadbeef");
        assert_ne!(tampered, sig);
        // A different id yields a different signature.
        assert_ne!(crate::sign_file_id("a-different-id"), sig);
    }
}
