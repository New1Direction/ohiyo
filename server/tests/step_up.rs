//! Actions a stolen session could use to do lasting damage need the password, as
//! deleting the account and changing the password already do: deleting a space,
//! replacing or deleting the recovery backup, and changing the dead-man's switch.

mod common;

use common::TestServer;
use serde_json::{json, Value};

const PASS: &str = "supersecret123";
const BACKUP: &str = "/api/v1/users/@me/key-backup";
const DEADMAN: &str = "/api/v1/users/@me/deadman";

#[tokio::test]
async fn deleting_a_space_needs_the_password() {
    let srv = TestServer::start().await;
    let ann = srv.register("stepspace", PASS).await;
    let server: Value = srv
        .post_json_auth("/api/v1/servers", &ann.token, json!({ "name": "Mine" }))
        .await
        .json()
        .await
        .unwrap();
    let path = format!("/api/v1/servers/{}", server["id"].as_str().unwrap());

    let res = srv.delete_auth(&path, &ann.token).await;
    assert!(
        res.status().is_client_error(),
        "no password: {}",
        res.status()
    );
    let res = srv
        .delete_json_auth(&path, &ann.token, json!({ "password": "not-it" }))
        .await;
    assert_eq!(res.status(), 403);
    assert_eq!(
        srv.get_auth(&path, &ann.token).await.status(),
        200,
        "still there"
    );

    let res = srv
        .delete_json_auth(&path, &ann.token, json!({ "password": PASS }))
        .await;
    assert_eq!(res.status(), 204);
}

#[tokio::test]
async fn replacing_or_deleting_the_recovery_backup_needs_the_password() {
    let srv = TestServer::start().await;
    let ann = srv.register("stepbackup", PASS).await;

    // The bare backup, as clients sent it before, is refused: a stolen session could
    // overwrite a good backup with junk.
    let res = srv
        .put_json_auth(BACKUP, &ann.token, json!({ "v": 2 }))
        .await;
    assert!(
        res.status().is_client_error(),
        "bare backup: {}",
        res.status()
    );
    let res = srv
        .put_json_auth(
            BACKUP,
            &ann.token,
            json!({ "password": "not-it", "backup": { "v": 2 } }),
        )
        .await;
    assert_eq!(res.status(), 403);
    assert_eq!(srv.get_auth(BACKUP, &ann.token).await.status(), 404);

    let res = srv
        .put_json_auth(
            BACKUP,
            &ann.token,
            json!({ "password": PASS, "backup": { "v": 2, "kdf": "pbkdf2" } }),
        )
        .await;
    assert_eq!(res.status(), 204);
    let stored: Value = srv.get_auth(BACKUP, &ann.token).await.json().await.unwrap();
    assert_eq!(
        stored,
        json!({ "v": 2, "kdf": "pbkdf2" }),
        "the backup itself is stored"
    );

    let res = srv.delete_auth(BACKUP, &ann.token).await;
    assert!(
        res.status().is_client_error(),
        "no password: {}",
        res.status()
    );
    assert_eq!(srv.get_auth(BACKUP, &ann.token).await.status(), 200);
    let res = srv
        .delete_json_auth(BACKUP, &ann.token, json!({ "password": PASS }))
        .await;
    assert_eq!(res.status(), 204);
    assert_eq!(srv.get_auth(BACKUP, &ann.token).await.status(), 404);
}

#[tokio::test]
async fn changing_the_dead_mans_switch_needs_the_password() {
    let srv = TestServer::start().await;
    let ann = srv.register("stepdeadman", PASS).await;
    let armed = |password: &str| json!({ "seconds": 7200, "scope": "keys", "password": password });

    let res = srv
        .post_json_auth(
            DEADMAN,
            &ann.token,
            json!({ "seconds": 7200, "scope": "keys" }),
        )
        .await;
    assert!(
        res.status().is_client_error(),
        "no password: {}",
        res.status()
    );
    let res = srv
        .post_json_auth(DEADMAN, &ann.token, armed("not-it"))
        .await;
    assert_eq!(res.status(), 403);
    let current: Value = srv
        .get_auth(DEADMAN, &ann.token)
        .await
        .json()
        .await
        .unwrap();
    assert!(current["seconds"].is_null(), "still off: {current}");

    let res = srv.post_json_auth(DEADMAN, &ann.token, armed(PASS)).await;
    assert_eq!(res.status(), 204);

    // Turning it off needs the password too: whoever holds an unlocked device must not
    // be able to quietly disarm it.
    let res = srv
        .post_json_auth(DEADMAN, &ann.token, json!({ "seconds": null }))
        .await;
    assert!(
        res.status().is_client_error(),
        "no password: {}",
        res.status()
    );
    let res = srv
        .post_json_auth(
            DEADMAN,
            &ann.token,
            json!({ "seconds": null, "password": PASS }),
        )
        .await;
    assert_eq!(res.status(), 204);
    let current: Value = srv
        .get_auth(DEADMAN, &ann.token)
        .await
        .json()
        .await
        .unwrap();
    assert!(current["seconds"].is_null(), "off again: {current}");
}

#[tokio::test]
async fn guessing_the_password_through_these_is_slowed_down() {
    let srv = TestServer::start().await;
    let ann = srv.register("stepguess", PASS).await;
    let mut statuses = Vec::new();
    for i in 0..8 {
        let res = srv
            .delete_json_auth(
                BACKUP,
                &ann.token,
                json!({ "password": format!("guess-{i}") }),
            )
            .await;
        statuses.push(res.status());
    }
    assert!(
        statuses.contains(&reqwest::StatusCode::TOO_MANY_REQUESTS),
        "8 wrong passwords in a row must hit the limit: {statuses:?}"
    );
}
