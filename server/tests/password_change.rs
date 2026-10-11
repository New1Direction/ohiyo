//! Changing the password needs the current one, and ends every session: a copied token
//! or someone who knew the old password is out. The caller gets a fresh token, so the
//! device it was changed on stays signed in.

mod common;

use common::{ws::Gateway, TestServer};
use serde_json::{json, Value};

async fn login(srv: &TestServer, username: &str, password: &str) -> reqwest::Response {
    srv.post_json(
        "/api/v1/auth/login",
        json!({ "username": username, "password": password }),
    )
    .await
}

async fn change(srv: &TestServer, token: &str, current: &str, new: &str) -> reqwest::Response {
    srv.post_json_auth(
        "/api/v1/auth/password",
        token,
        json!({ "current_password": current, "new_password": new }),
    )
    .await
}

#[tokio::test]
async fn a_new_password_ends_every_other_session_and_keeps_this_one() {
    let srv = TestServer::start().await;
    let me = srv.register("pwchange", "old-password-1").await;
    // A second session, as on another device (or a copied token).
    let other: Value = login(&srv, "pwchange", "old-password-1")
        .await
        .json()
        .await
        .unwrap();
    let other_token = other["token"].as_str().unwrap().to_owned();
    let mut other_ws = Gateway::connect(&srv, &other_token).await;

    let res = change(&srv, &me.token, "old-password-1", "new-password-2").await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    let fresh = body["token"].as_str().unwrap();
    assert_eq!(body["user"]["id"], me.id.as_str());

    // This device carries on with the fresh token; every token from before is dead.
    assert_eq!(srv.get_auth("/api/v1/users/@me", fresh).await.status(), 200);
    assert_eq!(
        srv.get_auth("/api/v1/users/@me", &me.token).await.status(),
        401
    );
    assert_eq!(
        srv.get_auth("/api/v1/users/@me", &other_token)
            .await
            .status(),
        401
    );
    // The other session's live socket is closed too.
    other_ws.wait_closed().await;

    // Only the new password signs in.
    assert_eq!(
        login(&srv, "pwchange", "old-password-1").await.status(),
        401
    );
    assert_eq!(
        login(&srv, "pwchange", "new-password-2").await.status(),
        200
    );
}

#[tokio::test]
async fn a_wrong_current_password_changes_nothing() {
    let srv = TestServer::start().await;
    let me = srv.register("pwwrong", "old-password-1").await;
    let res = change(&srv, &me.token, "not-my-password", "new-password-2").await;
    // 403, not 401: the session is fine, so the app must not read it as signed out.
    assert_eq!(res.status(), 403);
    assert_eq!(
        srv.get_auth("/api/v1/users/@me", &me.token).await.status(),
        200
    );
    assert_eq!(login(&srv, "pwwrong", "old-password-1").await.status(), 200);
    assert_eq!(login(&srv, "pwwrong", "new-password-2").await.status(), 401);
}

#[tokio::test]
async fn a_short_new_password_is_refused() {
    let srv = TestServer::start().await;
    let me = srv.register("pwshort", "old-password-1").await;
    assert_eq!(
        change(&srv, &me.token, "old-password-1", "short")
            .await
            .status(),
        400
    );
    assert_eq!(login(&srv, "pwshort", "old-password-1").await.status(), 200);
}

#[tokio::test]
async fn a_stolen_session_cannot_guess_the_current_password_quickly() {
    let srv = TestServer::start().await;
    let me = srv.register("pwguess", "old-password-1").await;
    let mut statuses = Vec::new();
    for i in 0..6 {
        statuses.push(
            change(&srv, &me.token, &format!("guess-{i}-xx"), "new-password-2")
                .await
                .status()
                .as_u16(),
        );
    }
    assert_eq!(statuses, vec![403, 403, 403, 403, 403, 429]);
    // Even the right password waits out the minute.
    assert_eq!(
        change(&srv, &me.token, "old-password-1", "new-password-2")
            .await
            .status(),
        429
    );
}

#[tokio::test]
async fn changing_the_password_needs_a_session() {
    let srv = TestServer::start().await;
    srv.register("pwnosession", "old-password-1").await;
    let res = srv
        .post_json(
            "/api/v1/auth/password",
            json!({ "current_password": "old-password-1", "new_password": "new-password-2" }),
        )
        .await;
    assert_eq!(res.status(), 401);
}
