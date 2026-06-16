//! Locks in the per-user upload quota (launch cluster 2): one account can't exhaust the
//! shared disk. Isolated in its own test binary because it sets a process-wide env var
//! (`MAX_UPLOAD_BYTES_PER_USER`) that the upload handler reads.

mod common;

use common::{multipart_file, TestServer};

#[tokio::test]
async fn upload_over_quota_is_rejected() {
    // Tiny quota for this binary; the upload handler reads it per-request.
    std::env::set_var("MAX_UPLOAD_BYTES_PER_USER", "10");

    let srv = TestServer::start().await;
    let alice = srv.register("alice", "password123").await;

    // 100 bytes against a 10-byte quota → rejected mid-stream.
    let (content_type, body) =
        multipart_file("file", "big.bin", "application/octet-stream", &[7u8; 100]);
    let res = srv
        .post_raw_auth("/api/v1/upload", &alice.token, &content_type, body)
        .await;
    assert_eq!(
        res.status(),
        413,
        "an upload exceeding the per-user quota must be rejected"
    );

    // A small file under the quota still succeeds.
    let (content_type, body) =
        multipart_file("file", "tiny.bin", "application/octet-stream", b"hi");
    let res = srv
        .post_raw_auth("/api/v1/upload", &alice.token, &content_type, body)
        .await;
    assert_eq!(res.status(), 200, "an upload within quota should succeed");
}
