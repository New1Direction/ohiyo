//! Locks in the epoch-based group rekey boundary (PRs #38–#41).
//!
//! Note on what the SERVER actually enforces: `distribute_sender_key` does NOT
//! validate a submitted epoch. The real server-side boundary is *membership* — the
//! `epoch` counter is bumped on every add/remove (so clients know to rekey), and a
//! removed member loses channel access, so the server will not forward them a fresh
//! sender key. These tests pin exactly that contract.

mod common;

use common::TestServer;
use serde_json::{json, Value};

const DMS: &str = "/api/v1/users/@me/dms";

/// Read a channel's current epoch as seen by `token` via the DM list.
async fn channel_epoch(srv: &TestServer, token: &str, channel_id: &str) -> i64 {
    let dms: Value = srv.get_auth(DMS, token).await.json().await.unwrap();
    dms.as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"].as_str() == Some(channel_id))
        .unwrap_or_else(|| panic!("channel {channel_id} not in caller's DM list"))["epoch"]
        .as_i64()
        .expect("epoch is an integer")
}

#[tokio::test]
async fn epoch_starts_at_zero_and_bumps_monotonically_on_membership_change() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "password123").await;
    let bob = srv.register("bob", "password123").await;
    let carol = srv.register("carol", "password123").await;

    // New group DM → epoch 0, caller is owner.
    let ch: Value = srv
        .post_json_auth(
            "/api/v1/users/@me/group-dms",
            &alice.token,
            json!({ "recipient_ids": [bob.id], "name": "g" }),
        )
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(ch["channel_type"].as_str(), Some("group_dm"));
    assert_eq!(ch["epoch"].as_i64(), Some(0));
    assert_eq!(ch["owner_id"].as_str(), Some(alice.id.as_str()));
    let cid = ch["id"].as_str().unwrap().to_owned();
    assert_eq!(channel_epoch(&srv, &alice.token, &cid).await, 0);

    // Adding a member rekeys: epoch 0 → 1.
    assert_eq!(
        srv.post_json_auth(
            &format!("/api/v1/channels/{cid}/recipients"),
            &alice.token,
            json!({ "user_id": carol.id }),
        )
        .await
        .status(),
        204
    );
    assert_eq!(channel_epoch(&srv, &alice.token, &cid).await, 1);

    // Removing a member rekeys again: epoch 1 → 2.
    assert_eq!(
        srv.delete_auth(
            &format!("/api/v1/channels/{cid}/recipients/{}", carol.id),
            &alice.token
        )
        .await
        .status(),
        204
    );
    assert_eq!(channel_epoch(&srv, &alice.token, &cid).await, 2);
}

#[tokio::test]
async fn membership_is_the_access_boundary_for_key_distribution() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "password123").await;
    let bob = srv.register("bob", "password123").await;
    let carol = srv.register("carol", "password123").await;
    let mallory = srv.register("mallory", "password123").await; // never a member

    let cid = srv
        .post_json_auth(
            "/api/v1/users/@me/group-dms",
            &alice.token,
            json!({ "recipient_ids": [bob.id, carol.id], "name": "g" }),
        )
        .await
        .json::<Value>()
        .await
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let sender_key = format!("/api/v1/channels/{cid}/sender-key");

    // A member can distribute; an outsider cannot.
    assert_eq!(
        srv.post_json_auth(
            &sender_key,
            &alice.token,
            json!({ "envelopes": { bob.id.clone(): "ENV_B" } })
        )
        .await
        .status(),
        204,
        "a member may distribute a sender key"
    );
    assert_eq!(
        srv.post_json_auth(&sender_key, &mallory.token, json!({ "envelopes": {} }))
            .await
            .status(),
        403,
        "a non-member must be denied"
    );

    // Remove Carol — she loses access entirely.
    assert_eq!(
        srv.delete_auth(
            &format!("/api/v1/channels/{cid}/recipients/{}", carol.id),
            &alice.token
        )
        .await
        .status(),
        204
    );
    assert_eq!(
        srv.get_auth(&format!("/api/v1/channels/{cid}/recipients"), &carol.token)
            .await
            .status(),
        403,
        "a removed member can no longer read the roster"
    );
    assert_eq!(
        srv.post_json_auth(&sender_key, &carol.token, json!({ "envelopes": {} }))
            .await
            .status(),
        403,
        "a removed member can no longer distribute keys"
    );

    // Roster reflects the removal for the remaining members.
    let roster: Value = srv
        .get_auth(&format!("/api/v1/channels/{cid}/recipients"), &bob.token)
        .await
        .json()
        .await
        .unwrap();
    let ids: Vec<&str> = roster
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|u| u["id"].as_str())
        .collect();
    assert!(ids.contains(&alice.id.as_str()) && ids.contains(&bob.id.as_str()));
    assert!(
        !ids.contains(&carol.id.as_str()),
        "removed member must be gone from the roster"
    );

    // Distributing a fresh key with an envelope still addressed to the removed member
    // succeeds but the server silently drops Carol's envelope (the dm_participants
    // filter). Full delivery-exclusion would require a gateway client to observe;
    // here we pin that it neither errors nor requires the caller to know she's gone.
    assert_eq!(
        srv.post_json_auth(
            &sender_key,
            &alice.token,
            json!({ "envelopes": { carol.id.clone(): "STALE" } })
        )
        .await
        .status(),
        204
    );
}
