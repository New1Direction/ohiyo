//! S-M8: Privacy Mode must hold over REST too, not only on the gateway. A Privacy Mode
//! user's DM read cursor and `last_active_at` are hidden from everyone but themselves.
//! Privacy Mode counts as on when it is saved in the user's prefs (even if they have
//! not connected since the server started) or switched on live over the gateway.

mod common;

use common::{AuthOk, TestServer};
use serde_json::{json, Value};

async fn open_dm(srv: &TestServer, from: &AuthOk, to: &AuthOk) -> String {
    let dm: Value = srv
        .post_json_auth(
            "/api/v1/users/@me/dms",
            &from.token,
            json!({ "recipient_id": to.id }),
        )
        .await
        .json()
        .await
        .unwrap();
    dm["id"].as_str().unwrap().to_owned()
}

async fn set_saved_privacy(srv: &TestServer, user: &AuthOk, on: bool) {
    let res = srv
        .post_json_auth(
            "/api/v1/users/@me/prefs",
            &user.token,
            json!({ "privacy": { "metadataMode": on } }),
        )
        .await;
    assert_eq!(res.status(), 204);
}

/// Equivalent of the gateway's `SetPrivacyMode` handler for a connected user.
fn set_live_privacy(srv: &TestServer, user: &AuthOk, on: bool) {
    let mut private = srv.state.privacy.write().unwrap();
    if on {
        private.insert(user.id.clone());
    } else {
        private.remove(&user.id);
    }
}

async fn reader_ids(srv: &TestServer, viewer: &AuthOk, channel_id: &str) -> Vec<String> {
    let res = srv
        .get_auth(
            &format!("/api/v1/channels/{channel_id}/reads"),
            &viewer.token,
        )
        .await;
    assert_eq!(res.status(), 200);
    let reads: Value = res.json().await.unwrap();
    reads
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["user_id"].as_str().unwrap().to_owned())
        .collect()
}

async fn seen_last_active(srv: &TestServer, viewer: &AuthOk, subject: &AuthOk) -> Value {
    let res = srv
        .get_auth(
            &format!("/api/v1/users/{}/profile", subject.id),
            &viewer.token,
        )
        .await;
    assert_eq!(res.status(), 200);
    let profile: Value = res.json().await.unwrap();
    profile["last_active_at"].clone()
}

#[tokio::test]
async fn read_cursors_of_privacy_mode_users_are_hidden_from_others() {
    let srv = TestServer::start().await;
    let alice = srv.register("readsalice", "supersecret123").await;
    let bob = srv.register("readsbob", "supersecret123").await;
    let channel_id = open_dm(&srv, &alice, &bob).await;

    let msg: Value = srv
        .post_json_auth(
            &format!("/api/v1/channels/{channel_id}/messages"),
            &alice.token,
            json!({ "content": "hi" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    for reader in [&alice.id, &bob.id] {
        sqlx::query(
            "INSERT INTO channel_reads (channel_id, user_id, last_read_message_id, last_read_at)
             VALUES (?,?,?,?)",
        )
        .bind(&channel_id)
        .bind(reader)
        .bind(msg["id"].as_str().unwrap())
        .bind(common::now_unix())
        .execute(&db)
        .await
        .unwrap();
    }

    let visible = reader_ids(&srv, &alice, &channel_id).await;
    assert!(
        visible.contains(&bob.id),
        "without Privacy Mode the cursor is shared"
    );

    // Saved preference, Bob not connected.
    set_saved_privacy(&srv, &bob, true).await;
    let for_alice = reader_ids(&srv, &alice, &channel_id).await;
    assert!(
        !for_alice.contains(&bob.id),
        "saved Privacy Mode hides Bob's cursor from Alice"
    );
    assert!(for_alice.contains(&alice.id), "Alice still sees her own");
    let for_bob = reader_ids(&srv, &bob, &channel_id).await;
    assert!(for_bob.contains(&bob.id), "Bob always sees his own cursor");
    assert!(for_bob.contains(&alice.id));

    // Live toggle over the gateway, saved preference off.
    set_saved_privacy(&srv, &bob, false).await;
    set_live_privacy(&srv, &bob, true);
    assert!(
        !reader_ids(&srv, &alice, &channel_id)
            .await
            .contains(&bob.id),
        "live Privacy Mode hides Bob's cursor from Alice"
    );
}

#[tokio::test]
async fn last_active_of_privacy_mode_users_is_hidden_from_others() {
    let srv = TestServer::start().await;
    let alice = srv.register("activealice", "supersecret123").await;
    let bob = srv.register("activebob", "supersecret123").await;
    let carol = srv.register("activecarol", "supersecret123").await;

    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    for user in [&bob, &carol] {
        sqlx::query("UPDATE users SET last_active_at = ? WHERE id = ?")
            .bind(common::now_unix())
            .bind(&user.id)
            .execute(&db)
            .await
            .unwrap();
    }
    assert!(
        seen_last_active(&srv, &alice, &bob).await.is_i64(),
        "without Privacy Mode last_active_at is shared"
    );

    // Saved preference, Bob not connected.
    set_saved_privacy(&srv, &bob, true).await;
    assert_eq!(seen_last_active(&srv, &alice, &bob).await, Value::Null);
    assert!(
        seen_last_active(&srv, &bob, &bob).await.is_i64(),
        "Bob still sees his own last_active_at"
    );

    // Live toggle over the gateway, nothing saved.
    set_live_privacy(&srv, &carol, true);
    assert_eq!(seen_last_active(&srv, &alice, &carol).await, Value::Null);
}
