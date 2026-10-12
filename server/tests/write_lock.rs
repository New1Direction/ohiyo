//! Requests that read and then write take SQLite's write lock up front.
//!
//! In WAL mode, a transaction that starts by reading holds a snapshot. If another write
//! commits before it writes, its write fails at once with SQLITE_BUSY: the busy timeout
//! doesn't help, and the request returned a 500. Seen when a new device published its
//! keys while its own gateway sign-in was writing. With the lock taken up front, the
//! request waits its turn instead.

mod common;

use std::time::Duration;

use common::TestServer;
use serde_json::json;
use sqlx::pool::PoolConnection;
use sqlx::Sqlite;

/// Another connection takes the write lock and changes a row, as a gateway sign-in does.
/// It commits when `release` runs.
async fn hold_the_write_lock(srv: &TestServer, user_id: &str) -> PoolConnection<Sqlite> {
    let mut other = srv.state.db.acquire().await.unwrap();
    sqlx::query("BEGIN IMMEDIATE")
        .execute(&mut *other)
        .await
        .unwrap();
    sqlx::query("UPDATE users SET last_active_at = COALESCE(last_active_at, 0) + 1 WHERE id = ?")
        .bind(user_id)
        .execute(&mut *other)
        .await
        .unwrap();
    other
}

async fn release(mut other: PoolConnection<Sqlite>) {
    // Long enough for the request to have read whatever it reads first.
    tokio::time::sleep(Duration::from_millis(400)).await;
    sqlx::query("COMMIT").execute(&mut *other).await.unwrap();
}

#[tokio::test]
async fn publishing_keys_waits_for_another_write_instead_of_failing() {
    let srv = TestServer::start().await;
    let alice = srv.register("lockalice", "supersecret123").await;

    let other = hold_the_write_lock(&srv, &alice.id).await;
    let publish = srv.post_json_auth(
        "/api/v1/signal/keys",
        &alice.token,
        json!({
            "device_id": 1,
            "identity_key": "IDENTITY_1",
            "registration_id": 1001,
            "signed_prekey": { "key_id": 1, "public_key": "SPK_PUB", "signature": "SPK_SIG" },
            "one_time_prekeys": [{ "key_id": 1, "public_key": "OTK_1" }],
        }),
    );
    let (res, ()) = tokio::join!(publish, release(other));
    assert_eq!(res.status(), 204);
}

#[tokio::test]
async fn redeeming_a_dm_link_waits_for_another_write_instead_of_failing() {
    let srv = TestServer::start().await;
    let alice = srv.register("lockdmalice", "supersecret123").await;
    let bob = srv.register("lockdmbob", "supersecret123").await;
    let created = srv
        .post_json_auth("/api/v1/users/@me/dm-links", &alice.token, json!({}))
        .await;
    assert_eq!(created.status(), 200);
    let token = created.json::<serde_json::Value>().await.unwrap()["token"]
        .as_str()
        .unwrap()
        .to_string();

    let other = hold_the_write_lock(&srv, &alice.id).await;
    let path = format!("/api/v1/dm-links/{token}");
    let redeem = srv.post_empty_auth(&path, &bob.token);
    let (res, ()) = tokio::join!(redeem, release(other));
    assert_eq!(res.status(), 200);
}
