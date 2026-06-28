//! Raw encrypted server-pack export for a single Ohiyo home.
//!
//! This is the ownership/export primitive that complements the Instant Servers
//! control-plane "ownership pack": it snapshots the current SQLite database and the
//! uploaded blob directory into a tar.gz with a signed manifest. The pack restores
//! infrastructure + ciphertext/opaque files. It does **not** contain users' recovery
//! codes, E2E private keys beyond whatever ciphertext/key-backup rows already exist in
//! the DB, or everyone else's readable plaintext history.

use std::{
    io::Read,
    path::{Path, PathBuf},
};

use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderValue, StatusCode},
    response::Response,
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio_util::io::ReaderStream;

use crate::{auth::AuthUser, types::now_unix, AppState};

type HmacSha256 = Hmac<Sha256>;

const EXPORT_FLAG: &str = "OHIYO_SERVER_PACK_EXPORT";
const EXPORT_SIGNING_SECRET: &str = "OHIYO_EXPORT_SIGNING_SECRET";

#[derive(Debug, Serialize, Deserialize)]
pub struct ServerPackManifest {
    pub version: u8,
    pub kind: String,
    pub generated_at: i64,
    pub software_version: String,
    pub public_base_url: Option<String>,
    pub schema: SchemaManifest,
    pub database: PackFileManifest,
    pub uploads: UploadsManifest,
    pub privacy_note: String,
    pub restore_note: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SchemaManifest {
    pub migrations_applied: i64,
    pub latest_migration_version: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PackFileManifest {
    pub path: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UploadsManifest {
    pub root: String,
    pub file_count: usize,
    pub total_bytes: u64,
    pub files: Vec<PackFileManifest>,
}

#[derive(Debug)]
struct UploadEntry {
    source: PathBuf,
    manifest: PackFileManifest,
}

fn truthy_env(name: &str) -> bool {
    std::env::var(name)
        .map(|value| {
            let value = value.trim().to_ascii_lowercase();
            matches!(value.as_str(), "1" | "true" | "yes" | "on")
        })
        .unwrap_or(false)
}

fn sqlite_path_from_env() -> Result<PathBuf, (StatusCode, String)> {
    let raw = std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite:ohiyo.db".to_owned());
    let Some(mut path) = raw.strip_prefix("sqlite:").map(str::to_owned) else {
        return Err((
            StatusCode::CONFLICT,
            "server-pack export only supports local SQLite homes".into(),
        ));
    };
    if let Some((before_query, _)) = path.split_once('?') {
        path = before_query.to_owned();
    }
    if path == ":memory:" || path.is_empty() {
        return Err((
            StatusCode::CONFLICT,
            "server-pack export needs a file-backed SQLite database".into(),
        ));
    }
    Ok(PathBuf::from(path))
}

fn sql_quote(s: &str) -> String {
    s.replace('\'', "''")
}

async fn assert_export_allowed(
    state: &AppState,
    user_id: &str,
) -> Result<(), (StatusCode, String)> {
    if !truthy_env(EXPORT_FLAG) {
        return Err((
            StatusCode::FORBIDDEN,
            "server-pack export is disabled on this home".into(),
        ));
    }

    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM servers")
        .fetch_one(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    if total == 0 {
        return Err((
            StatusCode::CONFLICT,
            "create and own a server before exporting this home".into(),
        ));
    }
    let not_owned: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM servers WHERE owner_id != ?")
        .bind(user_id)
        .fetch_one(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    if not_owned != 0 {
        return Err((
            StatusCode::FORBIDDEN,
            "server-pack export is only available to the owner of every server on this home".into(),
        ));
    }
    Ok(())
}

async fn snapshot_sqlite(state: &AppState, dest: &Path) -> Result<(), (StatusCode, String)> {
    let dest_str = dest.to_string_lossy();
    let sql = format!("VACUUM main INTO '{}'", sql_quote(&dest_str));
    sqlx::query(&sql)
        .execute(&state.db)
        .await
        .map_err(crate::api::error::internal)?;
    Ok(())
}

async fn schema_manifest(state: &AppState) -> SchemaManifest {
    let migrations_applied = sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM _sqlx_migrations")
        .fetch_one(&state.db)
        .await
        .unwrap_or(0);
    let latest_migration_version =
        sqlx::query_scalar::<_, Option<i64>>("SELECT MAX(version) FROM _sqlx_migrations")
            .fetch_one(&state.db)
            .await
            .ok()
            .flatten();
    SchemaManifest {
        migrations_applied,
        latest_migration_version,
    }
}

fn sha256_file(path: &Path) -> std::io::Result<(u64, String)> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        hasher.update(&buf[..n]);
    }
    Ok((total, format!("{:x}", hasher.finalize())))
}

fn collect_upload_entries(root: &Path) -> std::io::Result<Vec<UploadEntry>> {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<UploadEntry>) -> std::io::Result<()> {
        if !dir.exists() {
            return Ok(());
        }
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            let meta = entry.metadata()?;
            if meta.is_dir() {
                walk(root, &path, out)?;
            } else if meta.is_file() {
                let rel = path.strip_prefix(root).unwrap_or(&path);
                let rel = rel.to_string_lossy().replace('\\', "/");
                let archive_path = format!("uploads/{rel}");
                let (size_bytes, sha256) = sha256_file(&path)?;
                out.push(UploadEntry {
                    source: path,
                    manifest: PackFileManifest {
                        path: archive_path,
                        size_bytes,
                        sha256,
                    },
                });
            }
        }
        Ok(())
    }

    let mut out = Vec::new();
    walk(root, root, &mut out)?;
    out.sort_by(|a, b| a.manifest.path.cmp(&b.manifest.path));
    Ok(out)
}

fn sign_manifest(json: &[u8]) -> String {
    let secret = std::env::var(EXPORT_SIGNING_SECRET).unwrap_or_else(|_| crate::auth::jwt_secret());
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(json);
    format!("{:x}", mac.finalize().into_bytes())
}

fn append_file(
    tar: &mut tar::Builder<flate2::write::GzEncoder<std::fs::File>>,
    archive_path: &str,
    source: &Path,
) -> std::io::Result<()> {
    let mut file = std::fs::File::open(source)?;
    tar.append_file(archive_path, &mut file)
}

fn build_archive_blocking(
    archive_path: PathBuf,
    snapshot_path: PathBuf,
    upload_root: PathBuf,
    manifest_base: ServerPackManifest,
) -> Result<(), String> {
    let db_stats = sha256_file(&snapshot_path).map_err(|e| format!("hash db snapshot: {e}"))?;
    let uploads =
        collect_upload_entries(&upload_root).map_err(|e| format!("collect uploads: {e}"))?;
    let total_upload_bytes = uploads.iter().map(|entry| entry.manifest.size_bytes).sum();

    let manifest = ServerPackManifest {
        database: PackFileManifest {
            path: "ohiyo.db".into(),
            size_bytes: db_stats.0,
            sha256: db_stats.1,
        },
        uploads: UploadsManifest {
            root: "uploads".into(),
            file_count: uploads.len(),
            total_bytes: total_upload_bytes,
            files: uploads.iter().map(|entry| entry.manifest.clone()).collect(),
        },
        ..manifest_base
    };
    let manifest_json =
        serde_json::to_vec_pretty(&manifest).map_err(|e| format!("manifest json: {e}"))?;
    let signature = sign_manifest(&manifest_json);

    let archive_file =
        std::fs::File::create(&archive_path).map_err(|e| format!("create archive: {e}"))?;
    let encoder = flate2::write::GzEncoder::new(archive_file, flate2::Compression::default());
    let mut tar = tar::Builder::new(encoder);

    append_file(&mut tar, "ohiyo.db", &snapshot_path).map_err(|e| format!("append db: {e}"))?;
    for entry in &uploads {
        append_file(&mut tar, &entry.manifest.path, &entry.source)
            .map_err(|e| format!("append {}: {e}", entry.manifest.path))?;
    }

    let mut header = tar::Header::new_gnu();
    header.set_size(manifest_json.len() as u64);
    header.set_mode(0o600);
    header.set_cksum();
    tar.append_data(
        &mut header,
        "server-pack-manifest.json",
        manifest_json.as_slice(),
    )
    .map_err(|e| format!("append manifest: {e}"))?;

    let sig_bytes = format!("{signature}\n").into_bytes();
    let mut sig_header = tar::Header::new_gnu();
    sig_header.set_size(sig_bytes.len() as u64);
    sig_header.set_mode(0o600);
    sig_header.set_cksum();
    tar.append_data(
        &mut sig_header,
        "server-pack-manifest.hmac-sha256",
        sig_bytes.as_slice(),
    )
    .map_err(|e| format!("append signature: {e}"))?;

    let encoder = tar.into_inner().map_err(|e| format!("finish tar: {e}"))?;
    encoder.finish().map_err(|e| format!("finish gzip: {e}"))?;
    Ok(())
}

/// GET /api/v1/server-pack/export — download this home as a raw encrypted server pack.
pub async fn export_server_pack(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Response, (StatusCode, String)> {
    assert_export_allowed(&state, &auth.0).await?;
    let _db_path = sqlite_path_from_env()?;

    let tmp_dir =
        std::env::temp_dir().join(format!("ohiyo-server-pack-{}", crate::types::new_id()));
    tokio::fs::create_dir_all(&tmp_dir)
        .await
        .map_err(crate::api::error::internal)?;
    let snapshot_path = tmp_dir.join("ohiyo.db");
    let archive_path = tmp_dir.join("ohiyo-server-pack.tar.gz");

    snapshot_sqlite(&state, &snapshot_path)
        .await
        .inspect_err(|_| {
            let _ = std::fs::remove_dir_all(&tmp_dir);
        })?;

    let manifest_base = ServerPackManifest {
        version: 1,
        kind: "ohiyo_server_pack".into(),
        generated_at: now_unix(),
        software_version: env!("CARGO_PKG_VERSION").into(),
        public_base_url: std::env::var("PUBLIC_BASE_URL").ok().filter(|v| !v.trim().is_empty()),
        schema: schema_manifest(&state).await,
        database: PackFileManifest {
            path: "ohiyo.db".into(),
            size_bytes: 0,
            sha256: String::new(),
        },
        uploads: UploadsManifest {
            root: "uploads".into(),
            file_count: 0,
            total_bytes: 0,
            files: Vec::new(),
        },
        privacy_note: "This pack contains the server database, ciphertext messages, metadata, and uploaded blobs. It does not contain users' recovery codes or personal E2E private keys beyond encrypted/key-backup rows already stored as ciphertext.".into(),
        restore_note: "Restoring this pack recreates infrastructure and ciphertext. Readable history still depends on each user's own device keys or personal recovery backup.".into(),
    };

    let upload_root = crate::api::files::upload_dir();
    let archive_for_task = archive_path.clone();
    let snapshot_for_task = snapshot_path.clone();
    let task_tmp_dir = tmp_dir.clone();
    tokio::task::spawn_blocking(move || {
        build_archive_blocking(
            archive_for_task,
            snapshot_for_task,
            upload_root,
            manifest_base,
        )
    })
    .await
    .map_err(crate::api::error::internal)?
    .map_err(|e| {
        let _ = std::fs::remove_dir_all(&task_tmp_dir);
        (StatusCode::INTERNAL_SERVER_ERROR, e)
    })?;

    let file = tokio::fs::File::open(&archive_path)
        .await
        .map_err(crate::api::error::internal)?;
    // Unix keeps the opened file handle readable after unlink; removing the temp dir here
    // avoids accumulating export packs if clients disconnect mid-download.
    tokio::fs::remove_dir_all(&tmp_dir).await.ok();

    let stream = ReaderStream::new(file);
    let filename = format!("ohiyo-server-pack-{}.tar.gz", now_unix());
    let mut response = Response::new(Body::from_stream(stream));
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/gzip"),
    );
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!("attachment; filename=\"{filename}\""))
            .unwrap_or_else(|_| HeaderValue::from_static("attachment")),
    );
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_url_to_path_strips_query() {
        std::env::set_var("DATABASE_URL", "sqlite:/tmp/ohiyo.db?mode=rwc");
        assert_eq!(
            sqlite_path_from_env().unwrap(),
            PathBuf::from("/tmp/ohiyo.db")
        );
    }

    #[test]
    fn sql_quote_doubles_single_quotes() {
        assert_eq!(sql_quote("/tmp/a'b.db"), "/tmp/a''b.db");
    }

    #[test]
    fn upload_walk_is_sorted_and_relative() {
        let root = std::env::temp_dir().join(format!("ohiyo-pack-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("bb")).unwrap();
        std::fs::create_dir_all(root.join("aa")).unwrap();
        std::fs::write(root.join("bb/two"), b"two").unwrap();
        std::fs::write(root.join("aa/one"), b"one").unwrap();
        let got = collect_upload_entries(&root).unwrap();
        let paths: Vec<_> = got.into_iter().map(|e| e.manifest.path).collect();
        assert_eq!(paths, vec!["uploads/aa/one", "uploads/bb/two"]);
        std::fs::remove_dir_all(root).ok();
    }
}
