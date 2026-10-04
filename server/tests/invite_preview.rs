//! S-M4: invite previews are throttled to 30 a minute per user and per client address,
//! and new invite codes are 12 characters (existing shorter codes keep working).
//!
//! This binary runs as if on Fly (`FLY_APP_NAME` set), so `Fly-Client-IP` is the trusted
//! client address and each request can claim a distinct one.

mod common;

use std::sync::Once;

use common::{AuthOk, TestServer};
use serde_json::{json, Value};

const PREVIEWS_PER_MIN: usize = 30;

static FLY: Once = Once::new();

async fn start() -> TestServer {
    FLY.call_once(|| std::env::set_var("FLY_APP_NAME", "ohiyo-test"));
    TestServer::start().await
}

async fn invite_code(srv: &TestServer, owner: &AuthOk) -> String {
    let server: Value = srv
        .post_json_auth(
            "/api/v1/servers",
            &owner.token,
            json!({ "name": "Invites" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let invite: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{}/invites", server["id"].as_str().unwrap()),
            &owner.token,
            json!({}),
        )
        .await
        .json()
        .await
        .unwrap();
    invite["code"].as_str().unwrap().to_owned()
}

async fn preview(srv: &TestServer, user: &AuthOk, code: &str, client_ip: &str) -> u16 {
    srv.client
        .get(srv.url(&format!("/api/v1/invites/{code}")))
        .bearer_auth(&user.token)
        .header("fly-client-ip", client_ip)
        .send()
        .await
        .unwrap()
        .status()
        .as_u16()
}

#[tokio::test]
async fn previews_are_limited_per_user_across_addresses() {
    let srv = start().await;
    let owner = srv.register("previewowner", "password123").await;
    let code = invite_code(&srv, &owner).await;
    let scout = srv.register("scout", "password123").await;

    for i in 0..PREVIEWS_PER_MIN {
        assert_eq!(
            preview(&srv, &scout, &code, &format!("10.1.0.{}", i + 1)).await,
            200
        );
    }
    assert_eq!(
        preview(&srv, &scout, &code, "10.1.1.1").await,
        429,
        "a 31st preview by one user is throttled from a fresh address"
    );
}

#[tokio::test]
async fn previews_are_limited_per_address_across_users() {
    let srv = start().await;
    let owner = srv.register("previewowner", "password123").await;
    let code = invite_code(&srv, &owner).await;
    let first = srv.register("sharedfirst", "password123").await;
    let second = srv.register("sharedsecond", "password123").await;

    for _ in 0..20 {
        assert_eq!(preview(&srv, &first, &code, "10.2.0.1").await, 200);
    }
    for _ in 0..10 {
        assert_eq!(preview(&srv, &second, &code, "10.2.0.1").await, 200);
    }
    assert_eq!(
        preview(&srv, &second, &code, "10.2.0.1").await,
        429,
        "a 31st preview from one address is throttled for any user"
    );
    assert_eq!(preview(&srv, &second, &code, "10.2.0.2").await, 200);
}

#[tokio::test]
async fn new_codes_are_12_characters_and_old_short_codes_still_work() {
    let srv = start().await;
    let owner = srv.register("previewowner", "password123").await;
    let code = invite_code(&srv, &owner).await;
    assert_eq!(code.len(), 12, "{code}");

    // An invite minted before the change, with an 8-character code.
    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    sqlx::query(
        "INSERT INTO invites (code, server_id, channel_id, created_by, created_at, uses)
         SELECT 'abcd2345', server_id, channel_id, created_by, created_at, 0
         FROM invites WHERE code = ?",
    )
    .bind(&code)
    .execute(&db)
    .await
    .unwrap();
    let guest = srv.register("oldcodeguest", "password123").await;
    assert_eq!(preview(&srv, &guest, "abcd2345", "10.3.0.1").await, 200);
    let res = srv
        .post_json_auth("/api/v1/invites/abcd2345", &guest.token, json!({}))
        .await;
    assert_eq!(res.status(), 200, "an old code still redeems");
}
