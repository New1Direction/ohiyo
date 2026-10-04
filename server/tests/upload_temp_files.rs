//! S-H4: an upload streams into a `tmp-*` file before it is renamed into place. Every
//! way out of the upload handler other than that rename must remove the temp file.
//! Isolated in its own binary because it points the process-wide upload dir at a
//! private directory it can list.

mod common;

use common::TestServer;

fn temp_files(dir: &std::path::Path) -> Vec<String> {
    std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .filter(|name| name.starts_with("tmp-"))
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn an_upload_that_fails_mid_body_leaves_no_temp_file() {
    let dir = std::env::temp_dir().join(format!("ohiyo-tmp-{}", uuid::Uuid::new_v4()));
    std::env::set_var("OHIYO_UPLOAD_DIR", &dir);
    let srv = TestServer::start().await;
    let alice = srv.register("tmpalice", "password123").await;

    // A file part whose body stops before the closing boundary: the handler has
    // already opened its temp file when reading the part fails.
    let boundary = "ohiyotmpboundary";
    let body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"cut.bin\"\r\n\
         Content-Type: application/octet-stream\r\n\r\npartial bytes, then the stream ends"
    );
    let res = srv
        .post_raw_auth(
            "/api/v1/upload",
            &alice.token,
            &format!("multipart/form-data; boundary={boundary}"),
            body.into_bytes(),
        )
        .await;
    assert_eq!(res.status(), 400, "a truncated upload is rejected");

    assert_eq!(
        temp_files(&dir),
        Vec::<String>::new(),
        "the failed upload's temp file is removed"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
