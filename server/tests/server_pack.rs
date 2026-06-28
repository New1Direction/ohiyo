//! Server Pack export: a hosted/self-hosted home can export a raw encrypted data pack
//! (SQLite snapshot + uploads + signed manifest) without exposing plaintext E2E content.

mod common;

use common::{multipart_file, TestServer};
use flate2::read::GzDecoder;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;
use std::collections::HashMap;
use tar::Archive;

type HmacSha256 = Hmac<Sha256>;

async fn create_owned_server(srv: &TestServer, token: &str, name: &str) {
    let res = srv
        .post_json_auth("/api/v1/servers", token, json!({ "name": name }))
        .await;
    assert_eq!(res.status(), 200, "server create should succeed");
}

async fn upload_blob(srv: &TestServer, token: &str) {
    let (content_type, body) =
        multipart_file("file", "pack.txt", "text/plain", b"server-pack-test");
    let res = srv
        .post_raw_auth("/api/v1/upload", token, &content_type, body)
        .await;
    assert_eq!(res.status(), 200, "upload should succeed");
}

fn unpack(bytes: &[u8]) -> HashMap<String, Vec<u8>> {
    let gz = GzDecoder::new(bytes);
    let mut archive = Archive::new(gz);
    let mut out = HashMap::new();
    for entry in archive.entries().expect("tar entries") {
        let mut entry = entry.expect("tar entry");
        let path = entry
            .path()
            .expect("entry path")
            .to_string_lossy()
            .to_string();
        let mut buf = Vec::new();
        std::io::copy(&mut entry, &mut buf).expect("read entry");
        out.insert(path, buf);
    }
    out
}

fn hmac_hex(bytes: &[u8]) -> String {
    let mut mac =
        HmacSha256::new_from_slice(b"integration-test-secret-not-for-production").unwrap();
    mac.update(bytes);
    format!("{:x}", mac.finalize().into_bytes())
}

#[tokio::test]
async fn owner_downloads_signed_server_pack_with_db_and_uploads() {
    std::env::set_var("OHIYO_SERVER_PACK_EXPORT", "1");
    std::env::set_var(
        "OHIYO_UPLOAD_DIR",
        std::env::temp_dir()
            .join(format!("ohiyo-pack-uploads-{}", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .to_string(),
    );
    let srv = TestServer::start().await;
    let alice = srv.register("packalice", "supersecret123").await;
    let bob = srv.register("packbob", "supersecret123").await;
    create_owned_server(&srv, &alice.token, "Exportable").await;
    upload_blob(&srv, &alice.token).await;

    let denied = srv.get_auth("/api/v1/server-pack/export", &bob.token).await;
    assert_eq!(denied.status(), 403, "non-owner cannot export this home");

    let res = srv
        .get_auth("/api/v1/server-pack/export", &alice.token)
        .await;
    assert_eq!(res.status(), 200, "export should succeed");
    assert_eq!(
        res.headers().get("content-type").unwrap(),
        "application/gzip"
    );
    let bytes = res.bytes().await.unwrap();
    let files = unpack(&bytes);

    assert!(
        files.contains_key("ohiyo.db"),
        "pack includes sqlite snapshot"
    );
    assert!(
        files.keys().any(|name| name.starts_with("uploads/")),
        "pack includes uploaded blobs"
    );
    let manifest_bytes = files
        .get("server-pack-manifest.json")
        .expect("manifest present");
    let signature = String::from_utf8(
        files
            .get("server-pack-manifest.hmac-sha256")
            .expect("signature present")
            .clone(),
    )
    .unwrap();
    assert_eq!(signature.trim(), hmac_hex(manifest_bytes));

    let manifest: Value = serde_json::from_slice(manifest_bytes).unwrap();
    assert_eq!(manifest["version"], 1);
    assert_eq!(manifest["kind"], "ohiyo_server_pack");
    assert_eq!(manifest["database"]["path"], "ohiyo.db");
    assert!(manifest["database"]["sha256"].as_str().unwrap().len() == 64);
    assert!(manifest["uploads"]["file_count"].as_u64().unwrap() >= 1);
    assert!(manifest["restore_note"]
        .as_str()
        .unwrap()
        .contains("ciphertext"));
}
