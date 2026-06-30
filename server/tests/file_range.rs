//! Video/audio attachments need HTTP byte-range support: Safari/iOS media elements
//! commonly request `Range: bytes=0-` and will not reliably play MP4/MOV files from a
//! plain 200-only stream.

mod common;

use common::{multipart_file, TestServer};
use reqwest::header;
use serde_json::Value;

#[tokio::test]
async fn uploaded_files_support_single_byte_ranges() {
    let srv = TestServer::start().await;
    let alice = srv.register("range_alice", "password123").await;

    let bytes = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let (content_type, body) = multipart_file("file", "clip.mp4", "video/mp4", bytes);
    let upload = srv
        .post_raw_auth("/api/v1/upload", &alice.token, &content_type, body)
        .await;
    assert_eq!(upload.status(), 200, "upload should succeed");
    let uploaded: Value = upload.json().await.expect("upload json");
    let url = uploaded[0]["url"].as_str().expect("file url");

    let ranged = srv
        .client
        .get(srv.url(url))
        .header(header::RANGE, "bytes=10-15")
        .send()
        .await
        .expect("range request sent");
    assert_eq!(
        ranged.status(),
        206,
        "range request should be partial content"
    );
    assert_eq!(
        ranged
            .headers()
            .get(header::ACCEPT_RANGES)
            .and_then(|v| v.to_str().ok()),
        Some("bytes")
    );
    assert_eq!(
        ranged
            .headers()
            .get(header::CONTENT_RANGE)
            .and_then(|v| v.to_str().ok()),
        Some("bytes 10-15/36")
    );
    assert_eq!(
        ranged
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok()),
        Some("6")
    );
    let body = ranged.bytes().await.expect("range body");
    assert_eq!(&body[..], b"abcdef");
}
