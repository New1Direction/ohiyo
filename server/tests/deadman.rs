//! S-H5: the dead-man's switch must never wipe someone who is online. A user with a
//! live gateway session is skipped by the sweep, and gateway heartbeats keep
//! `last_active_at` fresh (at most one write per minute per connection).

mod common;

use common::{ws::Gateway, AuthOk, TestServer};
use serde_json::{json, Value};
use tokio::sync::broadcast;

const DEADMAN_SECS: i64 = 3600;

async fn create_server(srv: &TestServer, user: &AuthOk) -> String {
    let server: Value = srv
        .post_json_auth("/api/v1/servers", &user.token, json!({ "name": "Alive" }))
        .await
        .json()
        .await
        .unwrap();
    server["channels"][0]["id"].as_str().unwrap().to_owned()
}

async fn set_last_active(db: &sqlx::SqlitePool, user: &AuthOk, at: i64) {
    sqlx::query("UPDATE users SET last_active_at = ? WHERE id = ?")
        .bind(at)
        .bind(&user.id)
        .execute(db)
        .await
        .unwrap();
}

async fn last_active(db: &sqlx::SqlitePool, user: &AuthOk) -> i64 {
    sqlx::query_scalar("SELECT last_active_at FROM users WHERE id = ?")
        .bind(&user.id)
        .fetch_one(db)
        .await
        .unwrap()
}

async fn authored_messages(db: &sqlx::SqlitePool, user: &AuthOk) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM messages WHERE author_id = ?")
        .bind(&user.id)
        .fetch_one(db)
        .await
        .unwrap()
}

#[tokio::test]
async fn sweep_skips_users_with_a_live_gateway_session() {
    let srv = TestServer::start().await;
    let alice = srv.register("deadalice", "supersecret123").await;
    let channel_id = create_server(&srv, &alice).await;
    let res = srv
        .post_json_auth(
            &format!("/api/v1/channels/{channel_id}/messages"),
            &alice.token,
            json!({ "content": "still here" }),
        )
        .await;
    assert_eq!(res.status(), 200);
    let res = srv
        .post_json_auth(
            "/api/v1/users/@me/deadman",
            &alice.token,
            json!({ "seconds": DEADMAN_SECS }),
        )
        .await;
    assert_eq!(res.status(), 204);

    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    set_last_active(&db, &alice, common::now_unix() - 2 * DEADMAN_SECS).await;

    // A live gateway session, as the socket handler registers it.
    let (tx, _rx) = broadcast::channel(8);
    srv.state
        .sessions
        .write()
        .unwrap()
        .entry(alice.id.clone())
        .or_default()
        .insert(u64::MAX, tx);
    server::api::users::sweep_deadman(&srv.state).await;
    assert_eq!(
        authored_messages(&db, &alice).await,
        1,
        "an online user keeps their messages"
    );

    srv.state.sessions.write().unwrap().remove(&alice.id);
    server::api::users::sweep_deadman(&srv.state).await;
    assert_eq!(
        authored_messages(&db, &alice).await,
        0,
        "the same user with no session is wiped"
    );
}

/// Send a heartbeat, then an activity change whose PresenceUpdate echo proves the
/// gateway has finished handling the heartbeat (client events run in order).
async fn heartbeat_and_sync(gw: &mut Gateway, marker: &str) {
    gw.send(&json!({ "t": "Heartbeat" })).await;
    gw.send(&json!({
        "t": "SetActivity",
        "d": { "activity": { "kind": "playing", "name": marker, "details": null } }
    }))
    .await;
    gw.wait_for(|ev| ev["t"] == "PresenceUpdate" && ev["d"]["activity"]["name"] == marker)
        .await;
}

#[tokio::test]
async fn heartbeat_refreshes_last_active_at_at_most_once_a_minute() {
    let srv = TestServer::start().await;
    let alice = srv.register("heartalice", "supersecret123").await;
    // Presence echoes go to people sharing a server, so Alice needs one.
    create_server(&srv, &alice).await;
    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();

    let mut gw = Gateway::connect(&srv, &alice.token).await;
    gw.wait_for(|ev| ev["t"] == "Ready").await;

    let stale = common::now_unix() - 2 * DEADMAN_SECS;
    set_last_active(&db, &alice, stale).await;
    heartbeat_and_sync(&mut gw, "first").await;
    assert!(
        last_active(&db, &alice).await > stale,
        "the first heartbeat refreshes last_active_at"
    );

    set_last_active(&db, &alice, stale).await;
    heartbeat_and_sync(&mut gw, "second").await;
    assert_eq!(
        last_active(&db, &alice).await,
        stale,
        "a second heartbeat within a minute does not write again"
    );
}
