mod common;

use common::TestServer;
use serde_json::{json, Value};
use sqlx::SqlitePool;

async fn db(srv: &TestServer) -> SqlitePool {
    SqlitePool::connect(srv.db_url()).await.unwrap()
}

#[tokio::test]
async fn user_can_register_list_and_delete_content_free_push_device() {
    let srv = TestServer::start().await;
    let alice = srv.register("pushalice", "supersecret123").await;

    let cfg: Value = srv.get("/api/v1/push/config").await.json().await.unwrap();
    assert!(cfg["privacy_note"]
        .as_str()
        .unwrap()
        .contains("content-free"));
    assert!(cfg["privacy_note"]
        .as_str()
        .unwrap()
        .contains("not message text"));

    let res = srv
        .put_json_auth(
            "/api/v1/push/devices",
            &alice.token,
            json!({
                "platform": "web",
                "endpoint": "https://push.example/device-a",
                "p256dh": "p256dh-key",
                "auth": "auth-key",
                "device_name": "Mobile PWA"
            }),
        )
        .await;
    assert_eq!(res.status(), 200);
    let device: Value = res.json().await.unwrap();
    assert_eq!(device["platform"], "web");
    assert_eq!(device["device_name"], "Mobile PWA");

    let list: Value = srv
        .get_auth("/api/v1/push/devices", &alice.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(list.as_array().unwrap().len(), 1);

    let id = device["id"].as_str().unwrap();
    let deleted = srv
        .delete_auth(&format!("/api/v1/push/devices/{id}"), &alice.token)
        .await;
    assert_eq!(deleted.status(), 204);
}

#[tokio::test]
async fn relay_requires_secret_and_queues_without_content() {
    std::env::set_var("OHIYO_PUSH_RELAY_SECRET", "push-test-secret");
    let srv = TestServer::start().await;
    let alice = srv.register("relayalice", "supersecret123").await;

    let _ = srv
        .put_json_auth(
            "/api/v1/push/devices",
            &alice.token,
            json!({
                "platform": "fcm",
                "endpoint": "fcm-token-1",
                "device_name": "Android"
            }),
        )
        .await;

    let unauthorized = srv
        .post_json(
            "/api/v1/push/relay/content-free",
            json!({ "recipient_ids": [alice.id], "kind": "message" }),
        )
        .await;
    assert_eq!(unauthorized.status(), 401);

    let queued = srv
        .post_json_bearer(
            "/api/v1/push/relay/content-free",
            "push-test-secret",
            json!({ "recipient_ids": [alice.id], "kind": "message" }),
        )
        .await;
    assert_eq!(queued.status(), 200);
    let body: Value = queued.json().await.unwrap();
    assert_eq!(body["queued"], 1);

    let pool = db(&srv).await;
    let cols: Vec<(String, String, i64)> =
        sqlx::query_as("SELECT kind, status, attempts FROM push_deliveries")
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(cols, vec![("message".into(), "queued".into(), 0)]);

    // Schema guard: there is nowhere to store plaintext content in delivery rows.
    let info: Vec<(String,)> =
        sqlx::query_as("SELECT name FROM pragma_table_info('push_deliveries')")
            .fetch_all(&pool)
            .await
            .unwrap();
    let names: Vec<String> = info.into_iter().map(|(name,)| name).collect();
    assert!(!names
        .iter()
        .any(|n| n.contains("content") || n.contains("channel")));
}

#[tokio::test]
async fn dispatcher_retries_without_provider_and_never_adds_content() {
    std::env::set_var("OHIYO_PUSH_RELAY_SECRET", "push-test-secret");
    std::env::remove_var("OHIYO_FCM_SERVICE_ACCOUNT_JSON");
    std::env::remove_var("OHIYO_FCM_SERVICE_ACCOUNT_FILE");
    let srv = TestServer::start().await;
    let alice = srv.register("dispatchalice", "supersecret123").await;

    let _ = srv
        .put_json_auth(
            "/api/v1/push/devices",
            &alice.token,
            json!({
                "platform": "fcm",
                "endpoint": "fcm-token-1",
                "device_name": "Android"
            }),
        )
        .await;
    let queued = srv
        .post_json_bearer(
            "/api/v1/push/relay/content-free",
            "push-test-secret",
            json!({ "recipient_ids": [alice.id], "kind": "message" }),
        )
        .await;
    assert_eq!(queued.status(), 200);

    let dispatched = srv
        .post_json_bearer("/api/v1/push/dispatch", "push-test-secret", json!({}))
        .await;
    assert_eq!(dispatched.status(), 200);
    let body: Value = dispatched.json().await.unwrap();
    assert_eq!(body["attempted"], 1);
    assert_eq!(body["retried"], 1);
    assert_eq!(body["skipped_missing_provider"], 1);

    let pool = db(&srv).await;
    let row: (String, i64, Option<i64>, String) = sqlx::query_as(
        "SELECT status, attempts, next_attempt_at, COALESCE(last_error, '') FROM push_deliveries",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, "queued");
    assert_eq!(row.1, 1);
    assert!(row.2.is_some());
    assert!(row.3.contains("FCM service account missing"));
}

#[tokio::test]
async fn dispatch_endpoint_requires_relay_secret() {
    std::env::set_var("OHIYO_PUSH_RELAY_SECRET", "push-test-secret");
    let srv = TestServer::start().await;
    let unauthorized = srv.post_json("/api/v1/push/dispatch", json!({})).await;
    assert_eq!(unauthorized.status(), 401);
}

#[tokio::test]
async fn message_send_queues_content_free_push_for_offline_recipient() {
    let srv = TestServer::start().await;
    let alice = srv.register("pushsender", "supersecret123").await;
    let bob = srv.register("pushbob", "supersecret123").await;

    let _ = srv
        .put_json_auth(
            "/api/v1/push/devices",
            &bob.token,
            json!({
                "platform": "web",
                "endpoint": "https://push.example/bob",
                "p256dh": "p256dh-key",
                "auth": "auth-key",
                "device_name": "Bob phone"
            }),
        )
        .await;

    let dm: Value = srv
        .post_json_auth(
            "/api/v1/users/@me/dms",
            &alice.token,
            json!({ "recipient_id": bob.id }),
        )
        .await
        .json()
        .await
        .unwrap();
    let channel_id = dm["id"].as_str().unwrap();
    let sent = srv
        .post_json_auth(
            &format!("/api/v1/channels/{channel_id}/messages"),
            &alice.token,
            json!({ "content": "secret plaintext should not enter push rows", "attachment_ids": [] }),
        )
        .await;
    assert_eq!(sent.status(), 200);

    let pool = db(&srv).await;
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM push_deliveries WHERE user_id = ? AND kind = 'message'",
    )
    .bind(&bob.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(count, 1);
}
