//! Locks in the QR / one-time-code device-link flow (PR #16):
//!  - a minted code redeems to a session token for the SAME account;
//!  - codes are strictly single-use (consumed atomically on redeem);
//!  - minting a new code supersedes the prior one (one live code per user);
//!  - expired codes are rejected;
//!  - malformed/empty and unknown codes fail closed (no oracle);
//!  - redemption is per-IP rate limited.

mod common;

use common::{now_unix, TestServer};
use serde_json::json;

const START: &str = "/api/v1/devices/link/start";
const COMPLETE: &str = "/api/v1/devices/link/complete";

#[tokio::test]
async fn code_redeems_to_a_token_for_the_same_account_then_is_single_use() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "password123").await;

    // Mint a code on the primary device.
    let res = srv.post_empty_auth(START, &alice.token).await;
    assert_eq!(res.status(), 200);
    let start: serde_json::Value = res.json().await.unwrap();
    let code = start["code"].as_str().expect("code").to_owned();
    assert_eq!(code.len(), 12, "link code should be 12 chars");
    assert!(
        start["expires_at"].as_i64().unwrap() > now_unix(),
        "expiry should be in the future"
    );

    // Redeem it (no auth) — links to alice's account.
    let res = srv.post_json(COMPLETE, json!({ "code": code })).await;
    assert_eq!(res.status(), 200, "fresh code should redeem");
    let body: serde_json::Value = res.json().await.unwrap();
    assert_eq!(
        body["user"]["id"].as_str(),
        Some(alice.id.as_str()),
        "redeemed token must belong to the minting account"
    );

    // Second redemption of the same code must fail — single-use.
    let res = srv.post_json(COMPLETE, json!({ "code": code })).await;
    assert_eq!(res.status(), 404, "a consumed code must not redeem twice");
}

#[tokio::test]
async fn minting_a_new_code_supersedes_the_previous_one() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "password123").await;

    let code1: String = srv
        .post_empty_auth(START, &alice.token)
        .await
        .json::<serde_json::Value>()
        .await
        .unwrap()["code"]
        .as_str()
        .unwrap()
        .to_owned();

    let code2: String = srv
        .post_empty_auth(START, &alice.token)
        .await
        .json::<serde_json::Value>()
        .await
        .unwrap()["code"]
        .as_str()
        .unwrap()
        .to_owned();

    assert_ne!(code1, code2);
    // The superseded code is dead; only the latest one works.
    assert_eq!(
        srv.post_json(COMPLETE, json!({ "code": code1 }))
            .await
            .status(),
        404,
        "superseded code must be invalidated"
    );
    assert_eq!(
        srv.post_json(COMPLETE, json!({ "code": code2 }))
            .await
            .status(),
        200,
        "the latest code must still redeem"
    );
}

#[tokio::test]
async fn unknown_and_empty_codes_fail_closed() {
    let srv = TestServer::start().await;
    // Unknown but well-formed code → 404 (same generic failure as expired/used).
    assert_eq!(
        srv.post_json(COMPLETE, json!({ "code": "ZZZZZZZZZZZZ" }))
            .await
            .status(),
        404
    );
    // Code that normalises to empty → 400 "missing code".
    assert_eq!(
        srv.post_json(COMPLETE, json!({ "code": "!!!" }))
            .await
            .status(),
        400
    );
}

#[tokio::test]
async fn expired_codes_are_rejected() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "password123").await;

    // Seed an already-expired token directly (the 120s TTL is impractical to wait out).
    let pool = sqlx::SqlitePool::connect(srv.db_url())
        .await
        .expect("open test db");
    sqlx::query("INSERT INTO device_link_tokens (code, user_id, expires_at) VALUES (?, ?, ?)")
        .bind("EXPIREDXYZ99")
        .bind(&alice.id)
        .bind(now_unix() - 60)
        .execute(&pool)
        .await
        .expect("seed expired token");
    pool.close().await;

    let res = srv
        .post_json(COMPLETE, json!({ "code": "EXPIREDXYZ99" }))
        .await;
    assert_eq!(res.status(), 404, "an expired code must not redeem");
}

#[tokio::test]
async fn redemption_is_rate_limited_per_ip() {
    let srv = TestServer::start().await;
    // LINK_MAX_PER_MIN = 20 per 60s, keyed on client IP. The first 20 attempts pass
    // the limiter (and 404 on the bogus code); the 21st is throttled.
    for i in 0..20 {
        let status = srv
            .post_json(COMPLETE, json!({ "code": format!("BADCODE{i:05}") }))
            .await
            .status();
        assert_ne!(
            status, 429,
            "attempt {i} should not yet be throttled (got {status})"
        );
    }
    let status = srv
        .post_json(COMPLETE, json!({ "code": "BADCODE99999" }))
        .await
        .status();
    assert_eq!(
        status, 429,
        "the 21st redemption in the window must be throttled"
    );
}
