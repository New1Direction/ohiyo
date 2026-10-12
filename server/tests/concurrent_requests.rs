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

#[tokio::test]
async fn friend_requests_that_cross_make_them_friends() {
    let srv = TestServer::start().await;
    // Several pairs, each asking the other at the same moment.
    let mut pairs = Vec::new();
    for i in 0..4 {
        let a = srv.register(&format!("crossa{i}"), "supersecret123").await;
        let b = srv.register(&format!("crossb{i}"), "supersecret123").await;
        pairs.push((a, b));
    }
    let asks: Vec<(String, &str)> = pairs
        .iter()
        .flat_map(|(a, b)| {
            [
                (
                    format!("/api/v1/users/{}/friend-request", b.id),
                    a.token.as_str(),
                ),
                (
                    format!("/api/v1/users/{}/friend-request", a.id),
                    b.token.as_str(),
                ),
            ]
        })
        .collect();
    let asks = asks
        .iter()
        .map(|(path, token)| srv.post_empty_auth(path, token));
    let statuses: Vec<u16> = join_all(asks)
        .await
        .iter()
        .map(|res| res.status().as_u16())
        .collect();
    assert!(
        statuses.iter().all(|s| *s == 200),
        "every request is answered: {statuses:?}"
    );

    for (a, b) in &pairs {
        let relation: Value = srv
            .get_auth(&format!("/api/v1/users/{}/friendship", b.id), &a.token)
            .await
            .json()
            .await
            .unwrap();
        assert_eq!(
            relation["status"], "friends",
            "both asked, so they're friends"
        );
    }
}

#[tokio::test]
async fn adding_someone_to_a_group_twice_at_once_adds_them_once() {
    let srv = TestServer::start().await;
    let owner = srv.register("groupowner2", "supersecret123").await;
    let first = srv.register("groupfirst2", "supersecret123").await;
    let added = srv.register("groupadded2", "supersecret123").await;
    // Several groups, each getting the same person added three times at once.
    let mut groups = Vec::new();
    for i in 0..6 {
        let group: Value = srv
            .post_json_auth(
                "/api/v1/users/@me/group-dms",
                &owner.token,
                json!({ "recipient_ids": [first.id], "name": format!("twice {i}") }),
            )
            .await
            .json()
            .await
            .unwrap();
        groups.push(group["id"].as_str().unwrap().to_owned());
    }
    let paths: Vec<String> = groups
        .iter()
        .flat_map(|id| std::iter::repeat_n(format!("/api/v1/channels/{id}/recipients"), 3))
        .collect();
    let adds = paths
        .iter()
        .map(|path| srv.post_json_auth(path, &owner.token, json!({ "user_id": added.id })));
    let statuses: Vec<u16> = join_all(adds)
        .await
        .iter()
        .map(|res| res.status().as_u16())
        .collect();
    assert!(
        statuses.iter().all(|s| *s == 204),
        "every add is answered: {statuses:?}"
    );

    let chats: Value = srv
        .get_auth("/api/v1/users/@me/dms", &owner.token)
        .await
        .json()
        .await
        .unwrap();
    for id in &groups {
        let epoch = chats
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["id"] == id.as_str())
            .unwrap()["epoch"]
            .as_i64();
        assert_eq!(
            epoch,
            Some(1),
            "one member joined, so the keys moved on once"
        );
    }
}
