//! S-H1: user-supplied names and text that are stored and fanned out to other users have
//! length caps, counted in characters (not bytes), and anything longer is rejected with
//! 400. Every case sends a value exactly at the cap in a two-byte character (accepted,
//! which proves characters are counted) and one character over it (rejected).

mod common;

use common::{AuthOk, TestServer};
use serde_json::{json, Value};

/// `n` copies of a character that is two bytes in UTF-8.
fn chars(n: usize) -> String {
    "é".repeat(n)
}

async fn create_server(srv: &TestServer, owner: &AuthOk) -> String {
    let server: Value = srv
        .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": "Limits" }))
        .await
        .json()
        .await
        .unwrap();
    server["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn display_names_are_capped_at_64_characters() {
    let srv = TestServer::start().await;
    let register = |username: &str, display_name: String| {
        srv.post_json(
            "/api/v1/auth/register",
            json!({ "username": username, "password": "password123", "display_name": display_name }),
        )
    };
    assert_eq!(register("longname", chars(65)).await.status(), 400);
    assert_eq!(register("fitname", chars(64)).await.status(), 200);

    let alice = srv.register("limitalice", "password123").await;
    let update = |display_name: String| {
        srv.patch_json_auth(
            "/api/v1/users/@me/profile",
            &alice.token,
            json!({ "display_name": display_name }),
        )
    };
    assert_eq!(update(chars(65)).await.status(), 400);
    assert_eq!(update(chars(64)).await.status(), 200);
}

#[tokio::test]
async fn server_names_are_capped_at_100_characters() {
    let srv = TestServer::start().await;
    let owner = srv.register("limitowner", "password123").await;
    for (name, status) in [(chars(101), 400), (chars(100), 200)] {
        let res = srv
            .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": name }))
            .await;
        assert_eq!(res.status(), status);
    }
}

#[tokio::test]
async fn channel_names_and_topics_are_capped() {
    let srv = TestServer::start().await;
    let owner = srv.register("limitowner", "password123").await;
    let server_id = create_server(&srv, &owner).await;
    for (name, topic, status) in [
        (chars(101), chars(1), 400),
        (chars(1), chars(1025), 400),
        (chars(100), chars(1024), 200),
    ] {
        let res = srv
            .post_json_auth(
                &format!("/api/v1/servers/{server_id}/channels"),
                &owner.token,
                json!({ "name": name, "topic": topic }),
            )
            .await;
        assert_eq!(res.status(), status);
    }
}

#[tokio::test]
async fn role_names_are_capped_at_100_characters() {
    let srv = TestServer::start().await;
    let owner = srv.register("limitowner", "password123").await;
    let server_id = create_server(&srv, &owner).await;
    for (name, status) in [(chars(101), 400), (chars(100), 200)] {
        let res = srv
            .post_json_auth(
                &format!("/api/v1/servers/{server_id}/roles"),
                &owner.token,
                json!({ "name": name }),
            )
            .await;
        assert_eq!(res.status(), status);
    }
}

#[tokio::test]
async fn event_titles_and_descriptions_are_capped() {
    let srv = TestServer::start().await;
    let owner = srv.register("limitowner", "password123").await;
    let server_id = create_server(&srv, &owner).await;
    for (title, description, status) in [
        (chars(201), chars(1), 400),
        (chars(1), chars(4001), 400),
        (chars(200), chars(4000), 204),
    ] {
        let res = srv
            .post_json_auth(
                &format!("/api/v1/servers/{server_id}/events"),
                &owner.token,
                json!({ "title": title, "description": description, "starts_at": 2_000_000_000 }),
            )
            .await;
        assert_eq!(res.status(), status);
    }
}
