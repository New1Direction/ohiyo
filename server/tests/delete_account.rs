//! Deleting an account (DELETE /users/@me): at once, with the password and the username.
//! Every message the user sent goes. A space they own goes to its longest-standing other
//! member, or is deleted if nobody else is in it. What others still use (emoji added to
//! another space, a shared upload) stays. Keys, backup and sessions go; the username is
//! free again.

mod common;

use common::{multipart_file, now_unix, ws::Gateway, AuthOk, TestServer};
use serde_json::{json, Value};

const PASS: &str = "supersecret123";

async fn delete_me(
    srv: &TestServer,
    token: &str,
    password: &str,
    username: &str,
) -> reqwest::Response {
    srv.client
        .delete(srv.url("/api/v1/users/@me"))
        .bearer_auth(token)
        .json(&json!({ "password": password, "username": username }))
        .send()
        .await
        .unwrap()
}

async fn space(srv: &TestServer, owner: &AuthOk, name: &str) -> (String, String) {
    let s: Value = srv
        .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": name }))
        .await
        .json()
        .await
        .unwrap();
    (
        s["id"].as_str().unwrap().to_owned(),
        s["channels"][0]["id"].as_str().unwrap().to_owned(),
    )
}

async fn join(srv: &TestServer, owner: &AuthOk, server_id: &str, who: &AuthOk) {
    let invite: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/invites"),
            &owner.token,
            json!({}),
        )
        .await
        .json()
        .await
        .unwrap();
    let code = invite["code"].as_str().unwrap();
    let res = srv
        .post_json_auth(&format!("/api/v1/invites/{code}"), &who.token, json!({}))
        .await;
    assert_eq!(res.status(), 200, "join {server_id}");
}

async fn say(srv: &TestServer, who: &AuthOk, channel_id: &str, body: Value) -> String {
    let res = srv
        .post_json_auth(
            &format!("/api/v1/channels/{channel_id}/messages"),
            &who.token,
            body,
        )
        .await;
    assert_eq!(res.status(), 200, "send");
    res.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn upload(srv: &TestServer, who: &AuthOk, bytes: &[u8]) -> String {
    let (content_type, body) = multipart_file("file", "pic.png", "image/png", bytes);
    let res = srv
        .post_raw_auth("/api/v1/upload", &who.token, &content_type, body)
        .await;
    assert_eq!(res.status(), 200, "upload");
    res.json::<Value>().await.unwrap()[0]["id"]
        .as_str()
        .unwrap()
        .to_owned()
}

async fn count(db: &sqlx::SqlitePool, sql: &str, arg: &str) -> i64 {
    sqlx::query_scalar(sql)
        .bind(arg)
        .fetch_one(db)
        .await
        .unwrap()
}

#[tokio::test]
async fn deleting_an_account_removes_it_and_hands_on_what_others_still_use() {
    let srv = TestServer::start().await;
    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    let ann = srv.register("annleaves", PASS).await;
    let bea = srv.register("beastays", PASS).await;
    let cal = srv.register("calstays", PASS).await;

    // Ann owns "Shared" (Bea joined before Cal) and "Solo" (nobody else), and is a member
    // of Cal's "Cals".
    let (shared, shared_general) = space(&srv, &ann, "Shared").await;
    join(&srv, &ann, &shared, &bea).await;
    join(&srv, &ann, &shared, &cal).await;
    // Same second for both joins otherwise: make Bea clearly the longest-standing.
    sqlx::query(
        "UPDATE server_members SET joined_at = joined_at - 100 WHERE server_id = ? AND user_id = ?",
    )
    .bind(&shared)
    .bind(&bea.id)
    .execute(&db)
    .await
    .unwrap();
    let (solo, _) = space(&srv, &ann, "Solo").await;
    let (cals, cals_general) = space(&srv, &cal, "Cals").await;
    join(&srv, &cal, &cals, &ann).await;

    // Ann's messages, and Bea's reply, in both spaces.
    say(
        &srv,
        &ann,
        &shared_general,
        json!({ "content": "ann in shared" }),
    )
    .await;
    say(
        &srv,
        &ann,
        &cals_general,
        json!({ "content": "ann in cals" }),
    )
    .await;
    let bea_msg = say(
        &srv,
        &bea,
        &shared_general,
        json!({ "content": "bea stays" }),
    )
    .await;

    // Uploads: one only Ann uses (her avatar), one Bea attaches too (same bytes, so the
    // same file id, uploaded by Ann first).
    let avatar = upload(&srv, &ann, b"ann's face").await;
    // Set directly: the avatar endpoint builds a full URL from PUBLIC_BASE_URL.
    sqlx::query("UPDATE users SET avatar_url = ? WHERE id = ?")
        .bind(format!("http://localhost/api/v1/files/{avatar}"))
        .bind(&ann.id)
        .execute(&db)
        .await
        .unwrap();
    let shared_file = upload(&srv, &ann, b"a picture both use").await;
    say(
        &srv,
        &ann,
        &shared_general,
        json!({ "content": "pic", "attachment_ids": [shared_file] }),
    )
    .await;
    assert_eq!(
        upload(&srv, &bea, b"a picture both use").await,
        shared_file,
        "dedup gives the same id"
    );
    say(
        &srv,
        &bea,
        &shared_general,
        json!({ "content": "same pic", "attachment_ids": [shared_file] }),
    )
    .await;

    // An emoji Ann added to Cal's space (inserted directly: the permission path isn't
    // what this test is about).
    let emoji_file = upload(&srv, &ann, b"party parrot").await;
    sqlx::query(
        "INSERT INTO server_emojis (id, server_id, name, file_id, url, created_by, created_at)
         VALUES ('emoji-1', ?, 'parrot', ?, ?, ?, ?)",
    )
    .bind(&cals)
    .bind(&emoji_file)
    .bind(format!("/api/v1/files/{emoji_file}"))
    .bind(&ann.id)
    .bind(now_unix())
    .execute(&db)
    .await
    .unwrap();

    // Keys and a key backup.
    let keys = json!({ "device_id": 7, "identity_key": "ID", "registration_id": 7,
        "signed_prekey": { "key_id": 1, "public_key": "SPK", "signature": "SIG" },
        "one_time_prekeys": [{ "key_id": 1, "public_key": "OTK" }] });
    assert_eq!(
        srv.post_json_auth("/api/v1/signal/keys", &ann.token, keys)
            .await
            .status(),
        204
    );
    assert_eq!(
        srv.put_json_auth(
            "/api/v1/users/@me/key-backup",
            &ann.token,
            json!({ "password": PASS, "backup": { "v": 2 } })
        )
        .await
        .status(),
        204
    );

    let mut ann_ws = Gateway::connect(&srv, &ann.token).await;
    let mut bea_ws = Gateway::connect(&srv, &bea.token).await;

    assert_eq!(
        delete_me(&srv, &ann.token, PASS, "annleaves")
            .await
            .status(),
        204
    );

    // Ann is gone: sessions, sign-in, the row itself.
    ann_ws.wait_closed().await;
    assert_eq!(
        srv.get_auth("/api/v1/users/@me", &ann.token).await.status(),
        401
    );
    let login = srv
        .post_json(
            "/api/v1/auth/login",
            json!({ "username": "annleaves", "password": PASS }),
        )
        .await;
    assert_eq!(login.status(), 401);
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM users WHERE id = ?", &ann.id).await,
        0
    );

    // Every message she sent is gone; Bea's stay.
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM messages WHERE author_id = ?",
            &ann.id
        )
        .await,
        0
    );
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM messages WHERE id = ?", &bea_msg).await,
        1
    );

    // "Shared" now belongs to Bea, the longest-standing member; Bea's app is told.
    let owner: String = sqlx::query_scalar("SELECT owner_id FROM servers WHERE id = ?")
        .bind(&shared)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(owner, bea.id);
    let update = bea_ws
        .wait_for(|e| e["t"] == "ServerCreate" && e["d"]["id"] == shared.as_str())
        .await;
    assert_eq!(update["d"]["owner_id"], bea.id.as_str());
    // "Solo" had nobody else: deleted. Ann left Cal's space.
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM servers WHERE id = ?", &solo).await,
        0
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM server_members WHERE user_id = ?",
            &ann.id
        )
        .await,
        0
    );

    // Cal's space keeps the emoji, now credited to Cal.
    let credited: String =
        sqlx::query_scalar("SELECT created_by FROM server_emojis WHERE id = 'emoji-1'")
            .fetch_one(&db)
            .await
            .unwrap();
    assert_eq!(credited, cal.id);
    // The picture Bea still uses stays, now hers; Ann's avatar file is gone.
    let uploader: String = sqlx::query_scalar("SELECT uploader_id FROM files WHERE id = ?")
        .bind(&shared_file)
        .fetch_one(&db)
        .await
        .unwrap();
    assert_eq!(uploader, bea.id);
    assert_eq!(
        count(&db, "SELECT COUNT(*) FROM files WHERE id = ?", &avatar).await,
        0
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM files WHERE uploader_id = ?",
            &ann.id
        )
        .await,
        0
    );

    // Keys and backup are gone; nobody can start a session with her.
    for table in ["signal_identity", "signal_one_time_prekeys", "key_backups"] {
        let sql = format!("SELECT COUNT(*) FROM {table} WHERE user_id = ?");
        assert_eq!(count(&db, &sql, &ann.id).await, 0, "{table}");
    }

    // The username is free again (a new account, with a new id).
    let again = srv.register("annleaves", PASS).await;
    assert_ne!(again.id, ann.id);
}

#[tokio::test]
async fn a_group_she_owned_passes_to_the_next_member_and_rekeys() {
    let srv = TestServer::start().await;
    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    let ann = srv.register("anngroup", PASS).await;
    let bea = srv.register("beagroup", PASS).await;
    let cal = srv.register("calgroup", PASS).await;
    let group: Value = srv
        .post_json_auth(
            "/api/v1/users/@me/group-dms",
            &ann.token,
            json!({ "recipient_ids": [bea.id, cal.id], "name": "trio" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let group_id = group["id"].as_str().unwrap().to_owned();
    let epoch_before: i64 = sqlx::query_scalar("SELECT epoch FROM channels WHERE id = ?")
        .bind(&group_id)
        .fetch_one(&db)
        .await
        .unwrap();
    let mut bea_ws = Gateway::connect(&srv, &bea.token).await;

    assert_eq!(
        delete_me(&srv, &ann.token, PASS, "anngroup").await.status(),
        204
    );

    let (owner, epoch): (Option<String>, i64) =
        sqlx::query_as("SELECT owner_id, epoch FROM channels WHERE id = ?")
            .bind(&group_id)
            .fetch_one(&db)
            .await
            .unwrap();
    let owner = owner.expect("the group has an owner");
    assert!(
        owner == bea.id || owner == cal.id,
        "owner went to a remaining member"
    );
    assert!(epoch > epoch_before, "the group rekeys");
    let update = bea_ws.wait_for(|e| e["t"] == "GroupMembersUpdate").await;
    let left: Vec<&str> = update["d"]["participants"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap())
        .collect();
    assert!(!left.contains(&ann.id.as_str()));
    assert_eq!(left.len(), 2);
}

#[tokio::test]
async fn the_wrong_password_or_username_deletes_nothing() {
    let srv = TestServer::start().await;
    let ann = srv.register("annkeeps", PASS).await;
    // 403, not 401: the session is fine, so the app must not read it as signed out.
    assert_eq!(
        delete_me(&srv, &ann.token, "not-my-password", "annkeeps")
            .await
            .status(),
        403
    );
    assert_eq!(
        delete_me(&srv, &ann.token, PASS, "AnnKeeps").await.status(),
        400
    );
    assert_eq!(delete_me(&srv, &ann.token, PASS, "").await.status(), 400);
    assert_eq!(
        srv.get_auth("/api/v1/users/@me", &ann.token).await.status(),
        200
    );
}

#[tokio::test]
async fn a_stolen_session_cannot_guess_the_password_quickly() {
    let srv = TestServer::start().await;
    let ann = srv.register("annguess", PASS).await;
    let mut statuses = Vec::new();
    for i in 0..6 {
        statuses.push(
            delete_me(&srv, &ann.token, &format!("guess-{i}-xx"), "annguess")
                .await
                .status()
                .as_u16(),
        );
    }
    assert_eq!(statuses, vec![403, 403, 403, 403, 403, 429]);
    assert_eq!(
        delete_me(&srv, &ann.token, PASS, "annguess").await.status(),
        429
    );
    assert_eq!(
        srv.get_auth("/api/v1/users/@me", &ann.token).await.status(),
        200
    );
}

#[tokio::test]
async fn deleting_needs_a_session() {
    let srv = TestServer::start().await;
    srv.register("annnosession", PASS).await;
    let res = srv
        .client
        .delete(srv.url("/api/v1/users/@me"))
        .json(&json!({ "password": PASS, "username": "annnosession" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 401);
}

// ── Instant Servers run on real machines ─────────────────────────────────────

use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

use async_trait::async_trait;
use server::provision::{
    MachineProvisioner, MachineState, ProvisionError, ProvisionRequest, ProvisionedMachine,
};

/// Stands in for the cloud: hands out machines, records what is destroyed, and can
/// refuse to destroy anything.
#[derive(Default)]
struct Cloud {
    destroyed: Mutex<Vec<String>>,
    refuse: AtomicBool,
}

#[async_trait]
impl MachineProvisioner for Cloud {
    async fn provision(&self, req: ProvisionRequest) -> Result<ProvisionedMachine, ProvisionError> {
        Ok(ProvisionedMachine {
            machine_id: format!("machine-{}", req.instance_id),
            volume_id: format!("volume-{}", req.instance_id),
            state: MachineState::Started,
        })
    }
    async fn status(&self, _: &str) -> Result<MachineState, ProvisionError> {
        Ok(MachineState::Started)
    }
    async fn start(&self, _: &str) -> Result<(), ProvisionError> {
        Ok(())
    }
    async fn stop(&self, _: &str) -> Result<(), ProvisionError> {
        Ok(())
    }
    async fn destroy(&self, id: &str) -> Result<(), ProvisionError> {
        self.gone(id)
    }
    async fn destroy_volume(&self, id: &str) -> Result<(), ProvisionError> {
        self.gone(id)
    }
}

impl Cloud {
    fn gone(&self, id: &str) -> Result<(), ProvisionError> {
        if self.refuse.load(Ordering::SeqCst) {
            return Err(ProvisionError::Upstream("cloud is down".into()));
        }
        self.destroyed.lock().unwrap().push(id.to_owned());
        Ok(())
    }
}

async fn with_instance(cloud: Arc<Cloud>, username: &str) -> (TestServer, AuthOk, String) {
    let srv = TestServer::start_with(|state| state.provisioner = cloud).await;
    let me = srv.register(username, PASS).await;
    let res = srv
        .post_json_auth(
            "/api/v1/instances",
            &me.token,
            json!({ "name": "My Roost" }),
        )
        .await;
    assert_eq!(res.status(), 200, "create instance");
    let id = res.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    (srv, me, id)
}

#[tokio::test]
async fn their_instant_servers_are_shut_down_and_deleted() {
    let cloud = Arc::new(Cloud::default());
    let (srv, me, id) = with_instance(cloud.clone(), "annhosts").await;
    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();

    assert_eq!(
        delete_me(&srv, &me.token, PASS, "annhosts").await.status(),
        204
    );

    let destroyed = cloud.destroyed.lock().unwrap().clone();
    assert!(
        destroyed.contains(&format!("machine-{id}")),
        "{destroyed:?}"
    );
    assert!(destroyed.contains(&format!("volume-{id}")), "{destroyed:?}");
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM hosted_instances WHERE id = ?",
            &id
        )
        .await,
        0
    );
}

#[tokio::test]
async fn if_the_cloud_refuses_nothing_is_deleted() {
    let cloud = Arc::new(Cloud::default());
    let (srv, me, id) = with_instance(cloud.clone(), "annstuck").await;
    let db = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    let (_, general) = space(&srv, &me, "Still Here").await;
    say(&srv, &me, &general, json!({ "content": "still here" })).await;
    cloud.refuse.store(true, Ordering::SeqCst);

    // 502: the instance couldn't be destroyed, so the account is left exactly as it was.
    // The app tells this apart from a proxy's 502 by the words.
    let res = delete_me(&srv, &me.token, PASS, "annstuck").await;
    assert_eq!(res.status(), 502);
    assert!(res.text().await.unwrap().contains("Instant Server"));
    assert_eq!(
        srv.get_auth("/api/v1/users/@me", &me.token).await.status(),
        200
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM hosted_instances WHERE id = ?",
            &id
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &db,
            "SELECT COUNT(*) FROM messages WHERE author_id = ?",
            &me.id
        )
        .await,
        1
    );

    // Once the cloud is back, deleting works.
    cloud.refuse.store(false, Ordering::SeqCst);
    assert_eq!(
        delete_me(&srv, &me.token, PASS, "annstuck").await.status(),
        204
    );
}
