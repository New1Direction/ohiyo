//! R-L1: some requests looked, then wrote. Two at once both passed the look, and the
//! second write broke a uniqueness rule and came back as a 500 "internal error".

mod common;

use common::TestServer;
use futures_util::future::join_all;
use serde_json::{json, Value};

#[tokio::test]
async fn registering_the_same_name_at_once_says_taken_not_error() {
    let srv = TestServer::start().await;
    let tries = (0..4).map(|_| {
        srv.post_json(
            "/api/v1/auth/register",
            json!({ "username": "samename", "password": "supersecret123" }),
        )
    });
    let statuses: Vec<u16> = join_all(tries)
        .await
        .iter()
        .map(|res| res.status().as_u16())
        .collect();
    assert_eq!(
        statuses.iter().filter(|s| **s == 200).count(),
        1,
        "one account is made: {statuses:?}"
    );
    assert!(
        statuses.iter().all(|s| *s == 200 || *s == 409),
        "the others are told the name is taken: {statuses:?}"
    );
}

#[tokio::test]
async fn a_reaction_tapped_several_times_at_once_never_errors() {
    let srv = TestServer::start().await;
    let ann = srv.register("tapreacts", "supersecret123").await;
    let space: Value = srv
        .post_json_auth("/api/v1/servers", &ann.token, json!({ "name": "Taps" }))
        .await
        .json()
        .await
        .unwrap();
    let channel = space["channels"][0]["id"].as_str().unwrap().to_owned();
    let message: Value = srv
        .post_json_auth(
            &format!("/api/v1/channels/{channel}/messages"),
            &ann.token,
            json!({ "content": "react to me" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let message = message["id"].as_str().unwrap().to_owned();

    let path = format!("/api/v1/channels/{channel}/messages/{message}/react/x");
    let taps = (0..6).map(|_| srv.post_empty_auth(&path, &ann.token));
    let statuses: Vec<u16> = join_all(taps)
        .await
        .iter()
        .map(|res| res.status().as_u16())
        .collect();
    assert!(
        statuses.iter().all(|s| *s == 204),
        "every tap is answered: {statuses:?}"
    );
}
