//! What one account can make the push relay store and do is bounded. Before, an account
//! could register any number of devices (each costing a queued row, inside the send
//! request, for every message it was sent), queued nudges were never cleaned up, and a
//! nudge with no provider configured was retried forever.

mod common;

use common::TestServer;
use serde_json::{json, Value};
use sqlx::SqlitePool;

async fn register(srv: &TestServer, token: &str, n: usize) -> reqwest::StatusCode {
    srv.put_json_auth(
        "/api/v1/push/devices",
        token,
        json!({
            "platform": "web",
            "endpoint": format!("https://fcm.googleapis.com/fcm/send/limit-{n}"),
            "p256dh": "p256dh-key",
            "auth": "auth-key",
            "device_name": format!("Device {n}")
        }),
    )
    .await
    .status()
}

#[tokio::test]
async fn an_account_keeps_at_most_ten_push_devices_the_newest() {
    let srv = TestServer::start().await;
    let ann = srv.register("tenann", "supersecret123").await;
    for n in 0..12 {
        assert_eq!(register(&srv, &ann.token, n).await, 200);
    }
    let devices: Vec<Value> = srv
        .get_auth("/api/v1/push/devices", &ann.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(devices.len(), 10);
    let names: Vec<&str> = devices
        .iter()
        .map(|d| d["device_name"].as_str().unwrap())
        .collect();
    assert!(names.contains(&"Device 11"), "the newest stays: {names:?}");
    assert!(!names.contains(&"Device 0"), "the oldest goes: {names:?}");
}

#[tokio::test]
async fn registering_push_devices_in_a_loop_is_slowed_down() {
    let srv = TestServer::start().await;
    let ann = srv.register("loopann", "supersecret123").await;
    let mut statuses = Vec::new();
    for n in 0..30 {
        statuses.push(register(&srv, &ann.token, n).await);
    }
    assert_eq!(statuses[0], 200);
    assert!(statuses.contains(&reqwest::StatusCode::TOO_MANY_REQUESTS));
}

#[tokio::test]
async fn a_device_waits_with_one_nudge_however_many_messages_arrive() {
    let srv = TestServer::start().await;
    let ann = srv.register("nudgeann", "supersecret123").await;
    let bob = srv.register("nudgebob", "supersecret123").await;
    assert_eq!(register(&srv, &bob.token, 1).await, 200);
    let dm: Value = srv
        .post_json_auth(
            "/api/v1/users/@me/dms",
            &ann.token,
            json!({ "recipient_id": bob.id }),
        )
        .await
        .json()
        .await
        .unwrap();
    let channel = dm["id"].as_str().unwrap();
    for i in 0..5 {
        let res = srv
            .post_json_auth(
                &format!("/api/v1/channels/{channel}/messages"),
                &ann.token,
                json!({ "content": format!("hello {i}"), "attachment_ids": [] }),
            )
            .await;
        assert_eq!(res.status(), 200);
    }
    let pool = SqlitePool::connect(srv.db_url()).await.unwrap();
    let waiting: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM push_deliveries WHERE user_id = ? AND status = 'queued'",
    )
    .bind(&bob.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(waiting, 1, "one wake-up is enough");
}

#[tokio::test]
async fn a_nudge_with_no_provider_gives_up_after_the_usual_tries() {
    std::env::set_var("OHIYO_PUSH_RELAY_SECRET", "push-test-secret");
    std::env::remove_var("OHIYO_FCM_SERVICE_ACCOUNT_JSON");
    std::env::remove_var("OHIYO_FCM_SERVICE_ACCOUNT_FILE");
    let srv = TestServer::start().await;
    let ann = srv.register("giveupann", "supersecret123").await;
    let res = srv
        .put_json_auth(
            "/api/v1/push/devices",
            &ann.token,
            json!({ "platform": "fcm", "endpoint": "fcm-token-giveup", "device_name": "Android" }),
        )
        .await;
    assert_eq!(res.status(), 200);
    let pool = SqlitePool::connect(srv.db_url()).await.unwrap();
    let device: String = sqlx::query_scalar("SELECT id FROM push_devices WHERE user_id = ?")
        .bind(&ann.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    // One try left.
    sqlx::query(
        "INSERT INTO push_deliveries (id, user_id, device_id, kind, status, attempts, created_at)
         VALUES ('last-try', ?, ?, 'message', 'queued', 4, 0)",
    )
    .bind(&ann.id)
    .bind(&device)
    .execute(&pool)
    .await
    .unwrap();

    let res = srv
        .post_json_bearer("/api/v1/push/dispatch", "push-test-secret", json!({}))
        .await;
    assert_eq!(res.status(), 200);
    let status: String =
        sqlx::query_scalar("SELECT status FROM push_deliveries WHERE id = 'last-try'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "failed");
}

#[tokio::test]
async fn nudges_that_waited_a_week_are_cleaned_up() {
    let srv = TestServer::start().await;
    let ann = srv.register("staleann", "supersecret123").await;
    let pool = SqlitePool::connect(srv.db_url()).await.unwrap();
    let old = common::now_unix() - 8 * 86_400;
    sqlx::query(
        "INSERT INTO push_deliveries (id, user_id, device_id, kind, status, attempts, created_at)
         VALUES ('stale', ?, NULL, 'message', 'queued', 0, ?)",
    )
    .bind(&ann.id)
    .bind(old)
    .execute(&pool)
    .await
    .unwrap();
    server::api::push::sweep_stale_push_rows(&srv.state).await;
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM push_deliveries WHERE id = 'stale'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}
