//! A push subscription belongs to the session that registered it. "Sign out everywhere",
//! "Not me" and a password change end every session, so the devices those sessions
//! registered must stop getting nudges. Otherwise a stolen session's subscription keeps
//! telling an attacker each time the person gets a message, long after it was thrown out.

mod common;

use common::TestServer;
use serde_json::{json, Value};
use sqlx::SqlitePool;

const ENDPOINT: &str = "https://fcm.googleapis.com/fcm/send/session-test";

async fn register_device(srv: &TestServer, token: &str) {
    let res = srv
        .put_json_auth(
            "/api/v1/push/devices",
            token,
            json!({
                "platform": "web",
                "endpoint": ENDPOINT,
                "p256dh": "p256dh-key",
                "auth": "auth-key",
                "device_name": "Phone"
            }),
        )
        .await;
    assert_eq!(res.status(), 200);
}

async fn open_dm(srv: &TestServer, token: &str, recipient: &str) -> String {
    let dm: Value = srv
        .post_json_auth(
            "/api/v1/users/@me/dms",
            token,
            json!({ "recipient_id": recipient }),
        )
        .await
        .json()
        .await
        .unwrap();
    dm["id"].as_str().unwrap().to_owned()
}

async fn send(srv: &TestServer, token: &str, channel_id: &str) {
    let res = srv
        .post_json_auth(
            &format!("/api/v1/channels/{channel_id}/messages"),
            token,
            json!({ "content": "hello", "attachment_ids": [] }),
        )
        .await;
    assert_eq!(res.status(), 200);
}

async fn nudges_for(srv: &TestServer, user_id: &str) -> i64 {
    let pool = SqlitePool::connect(srv.db_url()).await.unwrap();
    sqlx::query_scalar("SELECT COUNT(*) FROM push_deliveries WHERE user_id = ?")
        .bind(user_id)
        .fetch_one(&pool)
        .await
        .unwrap()
}

#[tokio::test]
async fn ending_every_session_stops_the_nudges() {
    let srv = TestServer::start().await;
    let ann = srv.register("sessann", "supersecret123").await;
    let bob = srv.register("sessbob", "supersecret123").await;
    register_device(&srv, &bob.token).await;
    let dm = open_dm(&srv, &ann.token, &bob.id).await;

    let res = srv
        .post_empty_auth("/api/v1/auth/logout-everywhere", &bob.token)
        .await;
    assert_eq!(res.status(), 204);

    send(&srv, &ann.token, &dm).await;
    assert_eq!(
        nudges_for(&srv, &bob.id).await,
        0,
        "a device registered by an ended session must get no nudge"
    );
}

#[tokio::test]
async fn after_a_password_change_this_device_registers_again_and_is_nudged() {
    let srv = TestServer::start().await;
    let ann = srv.register("pwann", "supersecret123").await;
    let bob = srv.register("pwbob", "supersecret123").await;
    register_device(&srv, &bob.token).await;
    let dm = open_dm(&srv, &ann.token, &bob.id).await;

    let changed: Value = srv
        .post_json_auth(
            "/api/v1/auth/password",
            &bob.token,
            json!({ "current_password": "supersecret123", "new_password": "a-new-password-456" }),
        )
        .await
        .json()
        .await
        .unwrap();
    send(&srv, &ann.token, &dm).await;
    assert_eq!(
        nudges_for(&srv, &bob.id).await,
        0,
        "the old session's registration stops with it"
    );

    // The device that changed the password carries on with its new session.
    register_device(&srv, changed["token"].as_str().unwrap()).await;
    send(&srv, &ann.token, &dm).await;
    assert_eq!(nudges_for(&srv, &bob.id).await, 1);
}

#[tokio::test]
async fn a_nudge_queued_before_the_sessions_ended_is_not_sent() {
    std::env::set_var("OHIYO_PUSH_RELAY_SECRET", "push-test-secret");
    let srv = TestServer::start().await;
    let ann = srv.register("queueann", "supersecret123").await;
    let bob = srv.register("queuebob", "supersecret123").await;
    register_device(&srv, &bob.token).await;
    let dm = open_dm(&srv, &ann.token, &bob.id).await;
    send(&srv, &ann.token, &dm).await;
    assert_eq!(nudges_for(&srv, &bob.id).await, 1, "queued while signed in");

    let res = srv
        .post_empty_auth("/api/v1/auth/logout-everywhere", &bob.token)
        .await;
    assert_eq!(res.status(), 204);

    let dispatched = srv
        .post_json_bearer("/api/v1/push/dispatch", "push-test-secret", json!({}))
        .await;
    assert_eq!(dispatched.status(), 200);
    let body: Value = dispatched.json().await.unwrap();
    assert_eq!(body["skipped_signed_out"], 1);
    assert_eq!(body["retried"], 0);

    let pool = SqlitePool::connect(srv.db_url()).await.unwrap();
    let status: String = sqlx::query_scalar("SELECT status FROM push_deliveries")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(status, "skipped");
}
