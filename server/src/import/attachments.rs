//! Re-host a discrawl-downloaded attachment into Ohiyo's content-addressed file store,
//! reusing the exact `uploads/<sha[0:2]>/<sha[2:4]>/<sha>` layout and `files` schema
//! from `api/files.rs`.

use anyhow::{bail, Result};
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;
use std::path::{Component, Path, PathBuf};

use super::model::SourceAttachment;
use super::{lookup_map, record_map};
use crate::types::{new_id, now_unix};

const UPLOAD_DIR: &str = "uploads";

/// Reject a source attachment path that could read an arbitrary host file. The
/// `local_path` is derived from `media_path`, an untrusted column in the (possibly
/// third-party) Discrawl archive: a relative value is joined onto the operator's
/// `media_root` (so a legitimate `local_path` is the *absolute* media-root path), and
/// an absolute `media_path` bypasses the root entirely. A malicious archive can use
/// `../` segments to climb out of `media_root` and read `/etc/passwd`, another tenant's
/// DB, etc.
///
/// The `media_root` confinement boundary is not threaded into this function (it is
/// consumed in `discrawl.rs` when `local_path` is built, and `rehost`'s only caller does
/// not carry it), so we cannot do a full `starts_with(media_root)` check here without a
/// cross-module signature change. This guard rejects the directory-traversal shape that
/// is unambiguously hostile — any `..` component in the resolved path — which a
/// legitimate content-addressed media path never contains. See the report for the
/// residual absolute-path gap.
fn confine_local_path(local_path: &str) -> Result<()> {
    if Path::new(local_path)
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        bail!("attachment path escapes the media root: {local_path}");
    }
    Ok(())
}

pub async fn rehost(
    db: &SqlitePool,
    import_id: &str,
    uploader_id: &str,
    att: &SourceAttachment,
) -> Result<String> {
    if let Some(id) = lookup_map(db, import_id, "attachment", &att.discord_id).await? {
        return Ok(id);
    }

    confine_local_path(&att.local_path)?;
    let bytes = tokio::fs::read(&att.local_path).await?;
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let size_bytes = bytes.len() as i64;

    // Content dedup: if these exact bytes already exist, reuse the row (and still record
    // the provenance mapping so a resumed run short-circuits next time).
    if let Some(existing) = sqlx::query_scalar::<_, String>("SELECT id FROM files WHERE sha256 = ?")
        .bind(&sha256)
        .fetch_optional(db)
        .await?
    {
        record_map(db, import_id, "attachment", &att.discord_id, &existing).await?;
        return Ok(existing);
    }

    let final_path = PathBuf::from(UPLOAD_DIR)
        .join(&sha256[..2])
        .join(&sha256[2..4])
        .join(&sha256);
    if let Some(parent) = final_path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    tokio::fs::write(&final_path, &bytes).await?;

    let (w, h) = match imagesize::size(&final_path) {
        Ok(dim) => (Some(dim.width as i64), Some(dim.height as i64)),
        Err(_) => (None, None),
    };

    let path_str = final_path.to_string_lossy().into_owned();
    let id = new_id();
    sqlx::query(
        "INSERT INTO files (id, uploader_id, filename, content_type, size_bytes, sha256, path, created_at, width, height)
         VALUES (?,?,?,?,?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(uploader_id)
    .bind(&att.filename)
    .bind(&att.content_type)
    .bind(size_bytes)
    .bind(&sha256)
    .bind(&path_str)
    .bind(now_unix())
    .bind(w)
    .bind(h)
    .execute(db)
    .await?;
    record_map(db, import_id, "attachment", &att.discord_id, &id).await?;
    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::import::create_import;
    use crate::import::tests::test_db;

    async fn temp_file(bytes: &[u8]) -> String {
        let mut path = std::env::temp_dir();
        path.push(format!("import-att-{}", new_id()));
        tokio::fs::write(&path, bytes).await.unwrap();
        path.to_string_lossy().to_string()
    }

    #[tokio::test]
    async fn rehost_creates_file_row_and_dedups() {
        let db = test_db().await;
        let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
        let path = temp_file(b"hello-bytes").await;
        let att = SourceAttachment {
            discord_id: "a-1".into(),
            filename: "note.txt".into(),
            content_type: "text/plain".into(),
            local_path: path.clone(),
        };

        let id1 = rehost(&db, &import_id, "u1", &att).await.unwrap();
        // Same content under a different source id must dedup to the same file row.
        let att2 = SourceAttachment {
            discord_id: "a-2".into(),
            local_path: path,
            ..att.clone()
        };
        let id2 = rehost(&db, &import_id, "u1", &att2).await.unwrap();
        assert_eq!(id1, id2);

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM files")
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn confine_rejects_parent_traversal_and_accepts_clean_paths() {
        // Traversal segments (relative or embedded in an absolute media-root path) are rejected.
        assert!(confine_local_path("../../etc/passwd").is_err());
        assert!(confine_local_path("/jobdir/cache/media/../../../etc/passwd").is_err());
        assert!(confine_local_path("media/../secret").is_err());
        // A clean content-addressed path (relative or the legit absolute media-root form) is fine.
        assert!(confine_local_path("aa/note.txt").is_ok());
        assert!(confine_local_path("/jobdir/cache/discrawl/media/aa/file.png").is_ok());
    }

    #[tokio::test]
    async fn rehost_rejects_traversal_path() {
        let db = test_db().await;
        let import_id = create_import(&db, "u1", "g", "s1").await.unwrap();
        let att = SourceAttachment {
            discord_id: "a-evil".into(),
            filename: "passwd".into(),
            content_type: "text/plain".into(),
            local_path: "../../../../../../etc/passwd".into(),
        };
        assert!(rehost(&db, &import_id, "u1", &att).await.is_err());
    }
}
