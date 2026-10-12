//! Each device's one-time prekeys are stored for others to start encrypted sessions with.
//! Nothing bounded them: every publish could add 200 keys of up to 1000 bytes under new
//! ids, so one account could fill the server's disk. A device now holds at most 500, and
//! publishing is limited per account.

mod common;

use common::TestServer;
use serde_json::{json, Value};
use sqlx::SqlitePool;

fn publish_body(first_key_id: i64, count: i64) -> Value {
    let keys: Vec<Value> = (first_key_id..first_key_id + count)
        .map(|id| json!({ "key_id": id, "public_key": format!("OTK{id}") }))
        .collect();
    json!({
        "device_id": 1,
        "identity_key": "ID_1",
        "registration_id": 1001,
        "signed_prekey": { "key_id": 1, "public_key": "SPK", "signature": "SIG" },
        "one_time_prekeys": keys,
    })
}

#[tokio::test]
async fn a_device_holds_at_most_500_one_time_prekeys() {
    let srv = TestServer::start().await;
    let ann = srv.register("prekeyann", "supersecret123").await;
    for batch in 0..4 {
        let res = srv
            .post_json_auth(
                "/api/v1/signal/keys",
                &ann.token,
                publish_body(batch * 200 + 1, 200),
            )
            .await;
        assert_eq!(res.status(), 204);
    }
    let pool = SqlitePool::connect(srv.db_url()).await.unwrap();
    let stored: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM signal_one_time_prekeys WHERE user_id = ? AND device_id = 1",
    )
    .bind(&ann.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(stored, 500, "800 offered, 500 kept");
}

#[tokio::test]
async fn publishing_keys_in_a_loop_is_slowed_down() {
    let srv = TestServer::start().await;
    let ann = srv.register("publishann", "supersecret123").await;
    let mut statuses = Vec::new();
    for _ in 0..40 {
        statuses.push(
            srv.post_json_auth("/api/v1/signal/keys", &ann.token, publish_body(1, 1))
                .await
                .status(),
        );
    }
    assert_eq!(statuses[0], 204);
    assert!(statuses.contains(&reqwest::StatusCode::TOO_MANY_REQUESTS));
}
