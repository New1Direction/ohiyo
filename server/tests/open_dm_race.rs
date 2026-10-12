//! R-L1: opening a DM looked for one between the two people, then made one if there was
//! none. Two opens at once (a double tap, or both people starting the chat together) both
//! found none, and the pair ended up with two separate DMs.

mod common;

use std::collections::HashSet;

use common::TestServer;
use serde_json::{json, Value};

#[tokio::test]
async fn opening_the_same_dm_at_once_makes_one_dm() {
    let srv = TestServer::start().await;
    let ann = srv.register("dmraceann", "supersecret123").await;
    let bea = srv.register("dmracebea", "supersecret123").await;

    // Four opens from each side, all at once.
    let opens = (0..8).map(|i| {
        let (me, them) = if i % 2 == 0 {
            (&ann, &bea)
        } else {
            (&bea, &ann)
        };
        srv.post_json_auth(
            "/api/v1/users/@me/dms",
            &me.token,
            json!({ "recipient_id": them.id }),
        )
    });
    let mut ids = HashSet::new();
    for res in futures_util::future::join_all(opens).await {
        assert_eq!(res.status(), 200);
        let dm: Value = res.json().await.unwrap();
        ids.insert(dm["id"].as_str().unwrap().to_owned());
    }
    assert_eq!(ids.len(), 1, "one DM between them, not {}", ids.len());

    let listed: Value = srv
        .get_auth("/api/v1/users/@me/dms", &ann.token)
        .await
        .json()
        .await
        .unwrap();
    let dms = listed
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["channel_type"] == "dm")
        .count();
    assert_eq!(dms, 1, "Ann's list holds one DM");
}
