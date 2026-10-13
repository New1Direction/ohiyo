//! Message search reads the search box like Discord: `from:`, `mentions:`, `in:`, `has:`,
//! `before:`/`after:`/`during:`, `pinned:` and the words left over, all of which must match.
//! It only ever looks at channels the searcher can read, never at DMs or group chats (they
//! are end-to-end encrypted), and pages newest first. `envelope=1` asks for the page with
//! its total; without it the answer is the plain list older apps expect.

mod common;

use common::{multipart_file, AuthOk, TestServer};
use serde_json::{json, Value};

const PASS: &str = "supersecret123";
const VIEW_CHANNEL: i64 = 1 << 6;

struct World {
    srv: TestServer,
    owner: AuthOk,
    member: AuthOk,
    space: String,
    general: String,
    random: String,
}

async fn world() -> World {
    let srv = TestServer::start().await;
    let owner = srv.register("searchowner", PASS).await;
    let member = srv.register("searchmember", PASS).await;
    let body: Value = srv
        .post_json_auth(
            "/api/v1/servers",
            &owner.token,
            json!({ "name": "Search HQ" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let space = body["id"].as_str().unwrap().to_owned();
    let general = body["channels"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["channel_type"] == "text")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let invite: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{space}/invites"),
            &owner.token,
            json!({}),
        )
        .await
        .json()
        .await
        .unwrap();
    let code = invite["code"].as_str().unwrap();
    let joined = srv
        .post_json_auth(&format!("/api/v1/invites/{code}"), &member.token, json!({}))
        .await;
    assert_eq!(joined.status(), 200, "join");
    let random: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{space}/channels"),
            &owner.token,
            json!({ "name": "random" }),
        )
        .await
        .json()
        .await
        .unwrap();
    World {
        random: random["id"].as_str().unwrap().to_owned(),
        srv,
        owner,
        member,
        space,
        general,
    }
}

async fn say_with(
    w: &World,
    who: &AuthOk,
    channel: &str,
    content: &str,
    files: &[String],
) -> String {
    let res = w
        .srv
        .post_json_auth(
            &format!("/api/v1/channels/{channel}/messages"),
            &who.token,
            json!({ "content": content, "attachment_ids": files }),
        )
        .await;
    assert_eq!(res.status(), 200, "send {content:?}");
    let body: Value = res.json().await.unwrap();
    body["id"].as_str().unwrap().to_owned()
}

async fn say(w: &World, who: &AuthOk, channel: &str, content: &str) -> String {
    say_with(w, who, channel, content, &[]).await
}

async fn upload(w: &World, who: &AuthOk, name: &str, content_type: &str, bytes: &[u8]) -> String {
    let (ct, body) = multipart_file("file", name, content_type, bytes);
    let res = w
        .srv
        .post_raw_auth("/api/v1/upload", &who.token, &ct, body)
        .await;
    assert_eq!(res.status(), 200, "upload {name}");
    let files: Value = res.json().await.unwrap();
    files[0]["id"].as_str().unwrap().to_owned()
}

/// A real 1×1 PNG, so nothing that sniffs the bytes takes it for anything else.
const PNG: &[u8] = &[
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
    0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0xF8, 0xCF, 0xC0, 0xF0,
    0x1F, 0x00, 0x05, 0x00, 0x01, 0xFF, 0x89, 0x99, 0x3D, 0x1D, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
];

async fn search_raw(w: &World, who: &AuthOk, query: &str) -> reqwest::Response {
    let q = urlencode(query);
    w.srv
        .get_auth(
            &format!(
                "/api/v1/servers/{}/search?q={q}&envelope=1&limit=50",
                w.space
            ),
            &who.token,
        )
        .await
}

async fn search(w: &World, who: &AuthOk, query: &str) -> Value {
    let res = search_raw(w, who, query).await;
    assert_eq!(res.status(), 200, "search {query:?}");
    res.json().await.unwrap()
}

async fn search_with(w: &World, who: &AuthOk, query: &str, extra: &str) -> Value {
    let q = urlencode(query);
    let res = w
        .srv
        .get_auth(
            &format!("/api/v1/servers/{}/search?q={q}&envelope=1{extra}", w.space),
            &who.token,
        )
        .await;
    assert_eq!(res.status(), 200, "search {query:?} {extra}");
    res.json().await.unwrap()
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// The contents of a page's messages, newest first.
fn contents(page: &Value) -> Vec<String> {
    page["messages"]
        .as_array()
        .unwrap_or_else(|| panic!("no messages in {page}"))
        .iter()
        .map(|m| m["content"].as_str().unwrap().to_owned())
        .collect()
}

async fn db(w: &World) -> sqlx::SqlitePool {
    sqlx::SqlitePool::connect(w.srv.db_url()).await.unwrap()
}

#[tokio::test]
async fn every_word_must_appear() {
    let w = world().await;
    say(&w, &w.owner, &w.general, "deploy failed today").await;
    say(&w, &w.owner, &w.general, "deploy worked").await;
    assert_eq!(
        contents(&search(&w, &w.member, "deploy failed").await),
        ["deploy failed today"]
    );
    assert_eq!(
        contents(&search(&w, &w.member, "\"failed today\"").await),
        ["deploy failed today"]
    );
}

#[tokio::test]
async fn from_finds_one_persons_messages() {
    let w = world().await;
    say(&w, &w.owner, &w.general, "said by the owner").await;
    say(&w, &w.member, &w.general, "said by the member").await;
    for q in [
        "from:searchmember",
        "from:SearchMember",
        "from:@searchmember",
    ] {
        assert_eq!(
            contents(&search(&w, &w.owner, q).await),
            ["said by the member"],
            "{q}"
        );
    }
    assert!(contents(&search(&w, &w.owner, "from:nobodyhere").await).is_empty());
}

#[tokio::test]
async fn mentions_finds_messages_naming_someone() {
    let w = world().await;
    say(&w, &w.member, &w.general, "hey @searchowner look at this").await;
    say(&w, &w.member, &w.general, "hey @searchownerx not you").await;
    say(&w, &w.member, &w.general, "mail searchowner@example.com").await;
    say(&w, &w.member, &w.general, "thanks @searchowner.").await;
    assert_eq!(
        contents(&search(&w, &w.member, "mentions:searchowner").await),
        ["thanks @searchowner.", "hey @searchowner look at this"]
    );
}

#[tokio::test]
async fn in_keeps_to_one_channel_and_its_threads() {
    let w = world().await;
    let started = say(&w, &w.owner, &w.general, "general talk").await;
    say(&w, &w.owner, &w.random, "random talk").await;
    let thread: Value = w
        .srv
        .post_json_auth(
            &format!("/api/v1/channels/{}/threads", w.general),
            &w.owner.token,
            json!({ "message_id": started, "name": "Side chat" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let thread_id = thread["id"].as_str().unwrap().to_owned();
    say(&w, &w.member, &thread_id, "thread talk").await;

    assert_eq!(
        contents(&search(&w, &w.member, "talk in:random").await),
        ["random talk"]
    );
    let general = search(&w, &w.member, "talk in:#General").await;
    assert_eq!(contents(&general), ["thread talk", "general talk"]);
    let listed = general["channels"].as_array().unwrap();
    let side = listed
        .iter()
        .find(|c| c["id"] == thread_id.as_str())
        .expect("the thread is named in the page's channels");
    assert_eq!(side["name"], "Side chat");
    assert_eq!(side["parent_id"], w.general.as_str());
    assert_eq!(side["parent_name"], "general");
    assert!(contents(&search(&w, &w.member, "talk in:nosuchroom").await).is_empty());
}

#[tokio::test]
async fn has_finds_links_files_images_and_embeds() {
    let w = world().await;
    say(&w, &w.owner, &w.general, "see https://example.com/x").await;
    let png = upload(&w, &w.owner, "pic.png", "image/png", PNG).await;
    say_with(
        &w,
        &w.owner,
        &w.general,
        "a picture",
        std::slice::from_ref(&png),
    )
    .await;
    let txt = upload(&w, &w.owner, "notes.txt", "text/plain", b"plain notes").await;
    say_with(&w, &w.owner, &w.general, "a document", &[txt]).await;
    let embedded = say(&w, &w.owner, &w.general, "a card").await;
    say(&w, &w.owner, &w.general, "nothing special").await;

    let pool = db(&w).await;
    sqlx::query("UPDATE messages SET embeds = ? WHERE id = ?")
        .bind(r#"[{"url":"https://example.com/card","title":"Card"}]"#)
        .bind(&embedded)
        .execute(&pool)
        .await
        .unwrap();
    // A Discord import stores bare file ids, not objects.
    sqlx::query(
        "INSERT INTO messages (id, channel_id, author_id, content, created_at, attachments)
         VALUES ('imported-pic', ?, ?, 'an imported picture', strftime('%s','now'), ?)",
    )
    .bind(&w.general)
    .bind(&w.owner.id)
    .bind(format!(r#"["{png}"]"#))
    .execute(&pool)
    .await
    .unwrap();

    assert_eq!(
        contents(&search(&w, &w.member, "has:link").await),
        ["see https://example.com/x"]
    );
    assert_eq!(
        contents(&search(&w, &w.member, "has:file").await),
        ["an imported picture", "a document", "a picture"]
    );
    assert_eq!(
        contents(&search(&w, &w.member, "has:image").await),
        ["an imported picture", "a picture"]
    );
    assert!(contents(&search(&w, &w.member, "has:video").await).is_empty());
    assert_eq!(
        contents(&search(&w, &w.member, "has:embed").await),
        ["a card"]
    );
}

#[tokio::test]
async fn dates_follow_the_searchers_own_days() {
    let w = world().await;
    let early = say(&w, &w.owner, &w.general, "dated early").await;
    let evening = say(&w, &w.owner, &w.general, "dated evening").await;
    let later = say(&w, &w.owner, &w.general, "dated later").await;
    let pool = db(&w).await;
    // 2026-03-10 12:00 UTC; 2026-03-11 02:00 UTC (still the 10th at UTC−7); 2026-03-12 12:00 UTC.
    for (id, at) in [
        (&early, 1_773_144_000_i64),
        (&evening, 1_773_194_400),
        (&later, 1_773_316_800),
    ] {
        sqlx::query("UPDATE messages SET created_at = ? WHERE id = ?")
            .bind(at)
            .bind(id)
            .execute(&pool)
            .await
            .unwrap();
    }
    assert_eq!(
        contents(&search_with(&w, &w.member, "dated during:2026-03-10", "&tz=0").await),
        ["dated early"]
    );
    // tz is minutes behind UTC, as a browser's getTimezoneOffset() gives it (UTC−7 → 420).
    assert_eq!(
        contents(&search_with(&w, &w.member, "dated during:2026-03-10", "&tz=420").await),
        ["dated evening", "dated early"]
    );
    assert_eq!(
        contents(&search_with(&w, &w.member, "dated before:2026-03-11", "&tz=0").await),
        ["dated early"]
    );
    assert_eq!(
        contents(&search_with(&w, &w.member, "dated after:2026-03-11", "&tz=0").await),
        ["dated later"]
    );
    let bad = w
        .srv
        .get_auth(
            &format!(
                "/api/v1/servers/{}/search?q=dated&envelope=1&tz=99999",
                w.space
            ),
            &w.member.token,
        )
        .await;
    assert_eq!(bad.status(), 400, "an impossible time zone");
}

#[tokio::test]
async fn pinned_finds_pinned_or_unpinned_messages() {
    let w = world().await;
    let pinned = say(&w, &w.owner, &w.general, "pin me").await;
    say(&w, &w.owner, &w.general, "leave me").await;
    let res = w
        .srv
        .post_empty_auth(
            &format!("/api/v1/channels/{}/messages/{pinned}/pin", w.general),
            &w.owner.token,
        )
        .await;
    assert!(res.status().is_success(), "pin");
    assert_eq!(
        contents(&search(&w, &w.member, "me pinned:true").await),
        ["pin me"]
    );
    assert_eq!(
        contents(&search(&w, &w.member, "me pinned:false").await),
        ["leave me"]
    );
}

#[tokio::test]
async fn filters_and_words_all_apply_together() {
    let w = world().await;
    say(&w, &w.member, &w.general, "release https://x.test/1").await;
    say(&w, &w.owner, &w.general, "release https://x.test/2").await;
    say(&w, &w.member, &w.general, "release notes").await;
    say(&w, &w.member, &w.random, "release https://x.test/3").await;
    assert_eq!(
        contents(
            &search(
                &w,
                &w.owner,
                "release from:searchmember has:link in:general"
            )
            .await
        ),
        ["release https://x.test/1"]
    );
}

#[tokio::test]
async fn a_channel_you_cant_see_never_shows_up() {
    let w = world().await;
    say(&w, &w.owner, &w.random, "secret plan").await;
    let pool = db(&w).await;
    sqlx::query(
        "INSERT INTO permission_overwrites
         (id, server_id, scope_type, scope_id, target_type, target_id, allow_permissions, deny_permissions, source, created_at)
         VALUES ('ow_hide_random', ?, 'channel', ?, 'everyone', NULL, 0, ?, 'test', 1)",
    )
    .bind(&w.space)
    .bind(&w.random)
    .bind(VIEW_CHANNEL)
    .execute(&pool)
    .await
    .unwrap();
    assert!(contents(&search(&w, &w.member, "secret").await).is_empty());
    assert!(contents(&search(&w, &w.member, "secret in:random").await).is_empty());
    assert_eq!(
        contents(&search(&w, &w.owner, "secret").await),
        ["secret plan"]
    );
}

#[tokio::test]
async fn dms_never_show_up() {
    let w = world().await;
    let dm: Value = w
        .srv
        .post_json_auth(
            "/api/v1/users/@me/dms",
            &w.owner.token,
            json!({ "recipient_id": w.member.id }),
        )
        .await
        .json()
        .await
        .unwrap();
    let dm_id = dm["id"].as_str().unwrap().to_owned();
    say(&w, &w.owner, &dm_id, "needle in a dm").await;
    assert!(contents(&search(&w, &w.member, "needle").await).is_empty());
    assert!(contents(&search(&w, &w.owner, "needle").await).is_empty());
}

#[tokio::test]
async fn pages_run_newest_first_without_gaps() {
    let w = world().await;
    let pool = db(&w).await;
    for i in 0..30 {
        sqlx::query(
            "INSERT INTO messages (id, channel_id, author_id, content, created_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(format!("item-{i:02}"))
        .bind(&w.general)
        .bind(&w.owner.id)
        .bind(format!("item {i:02}"))
        .bind(1_700_000_000_i64 + i)
        .execute(&pool)
        .await
        .unwrap();
    }
    let mut seen = Vec::new();
    for offset in [0, 10, 20] {
        let page = search_with(&w, &w.member, "item", &format!("&limit=10&offset={offset}")).await;
        assert_eq!(page["total"], 30);
        assert_eq!(page["total_capped"], false);
        seen.extend(contents(&page));
    }
    let want: Vec<String> = (0..30).rev().map(|i| format!("item {i:02}")).collect();
    assert_eq!(seen, want);
    let past = search_with(&w, &w.member, "item", "&limit=10&offset=30").await;
    assert!(contents(&past).is_empty());
}

#[tokio::test]
async fn the_total_stops_counting_at_a_hundred() {
    let w = world().await;
    let pool = db(&w).await;
    for i in 0..105 {
        sqlx::query(
            "INSERT INTO messages (id, channel_id, author_id, content, created_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(format!("bulk-{i}"))
        .bind(&w.general)
        .bind(&w.owner.id)
        .bind(format!("bulk {i}"))
        .bind(1_700_000_000_i64 + i)
        .execute(&pool)
        .await
        .unwrap();
    }
    let page = search(&w, &w.member, "bulk").await;
    assert_eq!(page["total"], 100);
    assert_eq!(page["total_capped"], true);
    assert_eq!(page["messages"].as_array().unwrap().len(), 50);
}

#[tokio::test]
async fn older_apps_still_get_a_plain_list() {
    let w = world().await;
    say(&w, &w.owner, &w.general, "old app search").await;
    let res = w
        .srv
        .get_auth(
            &format!("/api/v1/servers/{}/search?q=old", w.space),
            &w.member.token,
        )
        .await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert!(
        body.is_array(),
        "the answer without envelope=1 is a list: {body}"
    );
    assert_eq!(body[0]["content"], "old app search");
}

#[tokio::test]
async fn outsiders_and_overlong_searches_are_refused() {
    let w = world().await;
    let stranger = w.srv.register("searchstranger", PASS).await;
    assert_eq!(search_raw(&w, &stranger, "anything").await.status(), 403);
    let long = "a".repeat(501);
    assert_eq!(search_raw(&w, &w.member, &long).await.status(), 400);
}

#[tokio::test]
async fn an_archived_thread_is_still_searched_and_a_hidden_channels_thread_never_is() {
    let w = world().await;
    let pool = db(&w).await;
    // A thread in #general nobody has written in for a month (the app calls it archived).
    let started = say(&w, &w.owner, &w.general, "old topic").await;
    let old: Value = w
        .srv
        .post_json_auth(
            &format!("/api/v1/channels/{}/threads", w.general),
            &w.owner.token,
            json!({ "message_id": started, "name": "Old thread" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let old_id = old["id"].as_str().unwrap().to_owned();
    let reply = say(&w, &w.member, &old_id, "archived needle").await;
    sqlx::query("UPDATE messages SET created_at = created_at - 30 * 86400 WHERE id = ?")
        .bind(&reply)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        contents(&search(&w, &w.member, "needle in:general").await),
        ["archived needle"]
    );

    // A thread under #random, which the member then can't see.
    let started = say(&w, &w.owner, &w.random, "hidden topic").await;
    let hidden: Value = w
        .srv
        .post_json_auth(
            &format!("/api/v1/channels/{}/threads", w.random),
            &w.owner.token,
            json!({ "message_id": started, "name": "Hidden thread" }),
        )
        .await
        .json()
        .await
        .unwrap();
    let hidden_id = hidden["id"].as_str().unwrap().to_owned();
    say(&w, &w.owner, &hidden_id, "hidden needle").await;
    sqlx::query(
        "INSERT INTO permission_overwrites
         (id, server_id, scope_type, scope_id, target_type, target_id, allow_permissions, deny_permissions, source, created_at)
         VALUES ('ow_hide_random_threads', ?, 'channel', ?, 'everyone', NULL, 0, ?, 'test', 1)",
    )
    .bind(&w.space)
    .bind(&w.random)
    .bind(VIEW_CHANNEL)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        contents(&search(&w, &w.member, "needle").await),
        ["archived needle"],
        "the hidden channel's thread never shows up"
    );
    assert_eq!(
        contents(&search(&w, &w.owner, "needle").await),
        ["hidden needle", "archived needle"]
    );
}
