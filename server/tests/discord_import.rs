//! S-H6, S-H7: Discord imports run with the server's own reach (host files, the shared
//! Discord bot, archive-supplied URLs), so every local Discrawl and managed Discord
//! import route is for operators named in `OHIYO_OPERATOR_USER_IDS` only, on top of the
//! feature flags.
//!
//! Each test sets the same environment, so tests in this binary can't disturb each other.

mod common;

use common::{AuthOk, TestServer};
use reqwest::Method;
use serde_json::{json, Value};

/// Turn both import flavours on. Nothing in this binary may reach Discord: any https
/// request the server makes goes to a proxy on a closed local port and fails there.
fn enable_imports() {
    std::env::set_var("OHIYO_ENABLE_LOCAL_DISCRAWL_IMPORT", "1");
    std::env::set_var("OHIYO_ENABLE_MANAGED_DISCORD_IMPORT", "1");
    std::env::set_var("DISCORD_BOT_TOKEN", "not-a-real-token");
    std::env::set_var("OHIYO_DISCORD_CLIENT_ID", "0");
    std::env::set_var("HTTPS_PROXY", "http://127.0.0.1:9");
    std::env::remove_var("NO_PROXY");
    std::env::remove_var("no_proxy");
}

/// Call an import route as `user`; returns the status.
async fn call(srv: &TestServer, user: &AuthOk, method: Method, path: &str, body: Value) -> u16 {
    let req = srv
        .client
        .request(method, srv.url(path))
        .bearer_auth(&user.token);
    let req = if body.is_null() { req } else { req.json(&body) };
    req.send().await.expect("request sent").status().as_u16()
}

/// Every gated route, with a request an operator gets past the gate with but that
/// fails validation before anything is read, written or fetched.
fn gated_routes() -> Vec<(Method, &'static str, Value, u16)> {
    vec![
        (
            Method::POST,
            "/api/v1/imports/discord/managed/jobs",
            json!({ "guild_id": "x" }),
            400,
        ),
        (
            Method::GET,
            "/api/v1/imports/discord/managed/jobs/no-such-job",
            Value::Null,
            404,
        ),
        (
            Method::POST,
            "/api/v1/imports/discord/managed/run",
            json!({ "guild_id": "x" }),
            400,
        ),
        (
            Method::POST,
            "/api/v1/imports/discord/preview",
            json!({ "db_path": "notes.txt" }),
            400,
        ),
        (
            Method::POST,
            "/api/v1/imports/discord/run",
            json!({ "db_path": "notes.txt" }),
            400,
        ),
    ]
}

async fn upload_archive(srv: &TestServer, user: &AuthOk) -> u16 {
    let (content_type, body) = common::multipart_file("file", "notes.txt", "text/plain", b"x");
    srv.post_raw_auth(
        "/api/v1/imports/discord/archive",
        &user.token,
        &content_type,
        body,
    )
    .await
    .status()
    .as_u16()
}

#[tokio::test]
async fn only_operators_may_use_local_and_managed_import_routes() {
    enable_imports();
    let srv = TestServer::start().await;
    let operator = srv.register("importoperator", "password123").await;
    let user = srv.register("importuser", "password123").await;

    // Unset: nobody is an operator.
    std::env::remove_var("OHIYO_OPERATOR_USER_IDS");
    for who in [&operator, &user] {
        for (method, path, body, _) in gated_routes() {
            assert_eq!(call(&srv, who, method, path, body).await, 403, "{path}");
        }
        let guilds = call(
            &srv,
            who,
            Method::GET,
            "/api/v1/imports/discord/guilds",
            Value::Null,
        )
        .await;
        assert_eq!(guilds, 403, "guild list");
        assert_eq!(upload_archive(&srv, who).await, 403, "archive upload");
    }

    std::env::set_var("OHIYO_OPERATOR_USER_IDS", &operator.id);
    for (method, path, body, _) in gated_routes() {
        assert_eq!(call(&srv, &user, method, path, body).await, 403, "{path}");
    }
    let guilds = call(
        &srv,
        &user,
        Method::GET,
        "/api/v1/imports/discord/guilds",
        Value::Null,
    )
    .await;
    assert_eq!(guilds, 403, "guild list");
    assert_eq!(upload_archive(&srv, &user).await, 403, "archive upload");

    // The operator gets past the gate (and stops at validation instead).
    for (method, path, body, status) in gated_routes() {
        assert_eq!(
            call(&srv, &operator, method, path, body).await,
            status,
            "{path}"
        );
    }
    assert_eq!(upload_archive(&srv, &operator).await, 400, "archive upload");
}
