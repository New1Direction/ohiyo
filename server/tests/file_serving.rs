//! Locks in the file-serving XSS boundary (launch cluster 2): an uploaded document is
//! never reflected back as a renderable type. Active-content uploads (HTML/SVG) come
//! back as an opaque attachment; known-safe media still renders inline.

mod common;

use common::{multipart_file, TestServer};
use serde_json::Value;

async fn upload(srv: &TestServer, token: &str, name: &str, ct: &str, bytes: &[u8]) -> String {
    let (content_type, body) = multipart_file("file", name, ct, bytes);
    let res = srv
        .post_raw_auth("/api/v1/upload", token, &content_type, body)
        .await;
    assert_eq!(res.status(), 200, "upload should succeed");
    let files: Value = res.json().await.unwrap();
    files[0]["id"].as_str().expect("file id").to_owned()
}

#[tokio::test]
async fn uploaded_html_is_forced_to_download_not_rendered() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "password123").await;

    let id = upload(
        &srv,
        &alice.token,
        "evil.html",
        "text/html",
        b"<script>alert(document.cookie)</script>",
    )
    .await;

    let res = srv
        .client
        .get(srv.url(&format!("/files/{id}")))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.headers().get("content-type").unwrap(),
        "application/octet-stream",
        "HTML must NOT be served as text/html"
    );
    let cd = res
        .headers()
        .get("content-disposition")
        .unwrap()
        .to_str()
        .unwrap();
    assert!(
        cd.starts_with("attachment"),
        "HTML must be forced to download, got: {cd}"
    );
}

#[tokio::test]
async fn uploaded_svg_is_forced_to_download() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "password123").await;

    // SVG can carry <script> — must never render inline.
    let id = upload(
        &srv,
        &alice.token,
        "x.svg",
        "image/svg+xml",
        b"<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>",
    )
    .await;

    let res = srv
        .client
        .get(srv.url(&format!("/files/{id}")))
        .send()
        .await
        .unwrap();
    assert_eq!(
        res.headers().get("content-type").unwrap(),
        "application/octet-stream"
    );
    assert!(res
        .headers()
        .get("content-disposition")
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("attachment"));
}

#[tokio::test]
async fn uploaded_image_is_served_inline_with_its_type() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "password123").await;

    let id = upload(
        &srv,
        &alice.token,
        "pic.png",
        "image/png",
        b"\x89PNG\r\n\x1a\nfake",
    )
    .await;

    let res = srv
        .client
        .get(srv.url(&format!("/files/{id}")))
        .send()
        .await
        .unwrap();
    assert_eq!(
        res.headers().get("content-type").unwrap(),
        "image/png",
        "safe media keeps its content type"
    );
    assert!(res
        .headers()
        .get("content-disposition")
        .unwrap()
        .to_str()
        .unwrap()
        .starts_with("inline"));
}
