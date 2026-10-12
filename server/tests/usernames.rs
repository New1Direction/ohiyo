//! S-L1: usernames were case-sensitive and took any characters, so "Alice" and "alice"
//! could be two different people, and a name could hide look-alike letters. New names use
//! letters, numbers, dots, underscores and dashes, and count as taken whatever their case.
//! Names made before the rule keep working.

mod common;

use common::TestServer;
use futures_util::future::join_all;
use serde_json::{json, Value};

const PASSWORD: &str = "supersecret123";

async fn try_register(srv: &TestServer, username: &str) -> (u16, String) {
    let res = srv
        .post_json(
            "/api/v1/auth/register",
            json!({ "username": username, "password": PASSWORD }),
        )
        .await;
    let status = res.status().as_u16();
    (status, res.text().await.unwrap_or_default())
}

async fn login(srv: &TestServer, username: &str, password: &str) -> reqwest::Response {
    srv.post_json(
        "/api/v1/auth/login",
        json!({ "username": username, "password": password }),
    )
    .await
}

/// An account made before the rule: `username` with the same password as `copy_of`.
async fn add_older_account(srv: &TestServer, id: &str, username: &str, copy_of: &str) {
    sqlx::query(
        "INSERT INTO users (id, username, display_name, password_hash, created_at)
         SELECT ?, ?, ?, password_hash, created_at FROM users WHERE username = ?",
    )
    .bind(id)
    .bind(username)
    .bind(username)
    .bind(copy_of)
    .execute(&srv.state.db)
    .await
    .unwrap();
}

#[tokio::test]
async fn a_new_name_with_other_characters_is_refused_with_the_rule() {
    let srv = TestServer::start().await;
    for name in [
        "has space",
        "émile",
        "semi;colon",
        "at@sign",
        "tab\tname",
        "Ａlice",
    ] {
        let (status, body) = try_register(&srv, name).await;
        assert_eq!(status, 400, "{name:?} is refused: {body}");
        assert!(
            body.contains("letters, numbers, dots, underscores and dashes"),
            "the answer names the allowed characters: {body}"
        );
    }
    for name in ["dots.and-dashes_ok", "MixedCase9"] {
        let (status, body) = try_register(&srv, name).await;
        assert_eq!(status, 200, "{name:?} is allowed: {body}");
    }
}

#[tokio::test]
async fn a_name_that_differs_only_by_case_is_taken() {
    let srv = TestServer::start().await;
    srv.register("alice", PASSWORD).await;
    let (status, body) = try_register(&srv, "Alice").await;
    assert_eq!(status, 409, "{body}");
    assert!(body.contains("username taken"), "{body}");
}

#[tokio::test]
async fn sign_ups_for_one_name_in_two_cases_at_once_make_one_account() {
    let srv = TestServer::start().await;
    let names: Vec<String> = (0..4)
        .flat_map(|i| [format!("pair{i}"), format!("PAIR{i}")])
        .collect();
    let tries = names.iter().map(|name| {
        srv.post_json(
            "/api/v1/auth/register",
            json!({ "username": name, "password": PASSWORD }),
        )
    });
    let statuses: Vec<u16> = join_all(tries)
        .await
        .iter()
        .map(|res| res.status().as_u16())
        .collect();
    assert!(
        statuses.iter().all(|s| *s == 200 || *s == 409),
        "each is made or told the name is taken: {statuses:?}"
    );
    for i in 0..4 {
        let accounts: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM users WHERE username = ? COLLATE NOCASE")
                .bind(format!("pair{i}"))
                .fetch_one(&srv.state.db)
                .await
                .unwrap();
        assert_eq!(accounts, 1, "one account for pair{i}: {statuses:?}");
    }
}

#[tokio::test]
async fn signing_in_works_whatever_the_case_typed() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", PASSWORD).await;
    let res = login(&srv, "ALICE", PASSWORD).await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["user"]["id"], alice.id.as_str());
    assert_eq!(
        body["user"]["username"], "alice",
        "the name stays as it was made"
    );
}

#[tokio::test]
async fn two_older_names_that_differ_only_by_case_need_the_exact_case() {
    let srv = TestServer::start().await;
    let lower = srv.register("carl", PASSWORD).await;
    add_older_account(&srv, "older-carl", "Carl", "carl").await;

    assert_eq!(
        login(&srv, "CARL", PASSWORD).await.status(),
        401,
        "two accounts match, so neither is picked"
    );
    let upper: Value = login(&srv, "Carl", PASSWORD).await.json().await.unwrap();
    assert_eq!(upper["user"]["id"], "older-carl");
    let exact: Value = login(&srv, "carl", PASSWORD).await.json().await.unwrap();
    assert_eq!(exact["user"]["id"], lower.id.as_str());
}

#[tokio::test]
async fn an_older_name_with_other_characters_still_signs_in() {
    let srv = TestServer::start().await;
    srv.register("template", PASSWORD).await;
    add_older_account(&srv, "older-spaced", "Old Name!", "template").await;

    assert_eq!(login(&srv, "Old Name!", PASSWORD).await.status(), 200);
    assert_eq!(
        login(&srv, "old name!", PASSWORD).await.status(),
        200,
        "the only account with that name, whatever the case"
    );
}

#[tokio::test]
async fn the_per_name_login_limit_counts_every_case_of_the_name() {
    let srv = TestServer::start_with(|state| state.login_limit_per_username_per_minute = 3).await;
    srv.register("limitme", PASSWORD).await;
    for name in ["LIMITME", "LimitMe", "limitME"] {
        assert_eq!(login(&srv, name, "wrong-guess").await.status(), 401);
    }
    assert_eq!(
        login(&srv, "limitme", PASSWORD).await.status(),
        429,
        "three tries at one account, in any case, use up its limit"
    );
}
