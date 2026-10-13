//! Events grew up: an end time, a place (a voice or text channel in the space, or a place
//! of your own), editing, cancelling with a notice, three RSVP answers (Interested, Going,
//! Can't go), and reminders 15 minutes before and at the start for people who said
//! Interested or Going — sent once, and never to someone who silenced the space. The host
//! is down as Going from the start.

mod common;

use common::{now_unix, AuthOk, TestServer};
use serde_json::{json, Value};

const PASS: &str = "supersecret123";

struct Space {
    id: String,
    general: String,
    voice: String,
}

async fn space(srv: &TestServer, owner: &AuthOk, name: &str) -> Space {
    let s: Value = srv
        .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": name }))
        .await
        .json()
        .await
        .unwrap();
    let channel = |kind: &str| {
        s["channels"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["channel_type"] == kind)
            .unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    Space {
        id: s["id"].as_str().unwrap().to_owned(),
        general: channel("text"),
        voice: channel("voice"),
    }
}

async fn join(srv: &TestServer, owner: &AuthOk, space: &str, who: &AuthOk) {
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
    let res = srv
        .post_json_auth(&format!("/api/v1/invites/{code}"), &who.token, json!({}))
        .await;
    assert_eq!(res.status(), 200);
}

async fn create(srv: &TestServer, who: &AuthOk, space: &str, body: Value) -> reqwest::Response {
    srv.post_json_auth(&format!("/api/v1/servers/{space}/events"), &who.token, body)
        .await
}

async fn list(srv: &TestServer, who: &AuthOk, space: &str) -> Vec<Value> {
    let res = srv
        .get_auth(&format!("/api/v1/servers/{space}/events"), &who.token)
        .await;
    assert_eq!(res.status(), 200);
    res.json::<Vec<Value>>().await.unwrap()
}

async fn only_event(srv: &TestServer, who: &AuthOk, space: &str) -> Value {
    let events = list(srv, who, space).await;
    assert_eq!(events.len(), 1, "one event: {events:?}");
    events.into_iter().next().unwrap()
}

async fn rsvp(srv: &TestServer, who: &AuthOk, space: &str, event: &str, status: Value) -> u16 {
    srv.post_json_auth(
        &format!("/api/v1/servers/{space}/events/{event}/rsvp"),
        &who.token,
        json!({ "status": status }),
    )
    .await
    .status()
    .as_u16()
}

async fn push_device(srv: &TestServer, who: &AuthOk, tag: &str) {
    let res = srv
        .put_json_auth(
            "/api/v1/push/devices",
            &who.token,
            json!({
                "platform": "web",
                "endpoint": format!("https://fcm.googleapis.com/fcm/send/events-{tag}"),
                "p256dh": "p256dh-key",
                "auth": "auth-key",
                "device_name": "Phone"
            }),
        )
        .await;
    assert_eq!(res.status(), 200);
}

async fn event_pushes(srv: &TestServer, who: &AuthOk) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM push_deliveries WHERE user_id = ? AND kind = 'event'")
        .bind(&who.id)
        .fetch_one(&srv.state.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn an_event_keeps_its_end_time_and_place() {
    let srv = TestServer::start().await;
    let a = srv.register("evhost", PASS).await;
    let s = space(&srv, &a, "Places").await;
    let start = now_unix() + 3600;
    let res = create(
        &srv,
        &a,
        &s.id,
        json!({
            "title": "Game night",
            "starts_at": start,
            "ends_at": start + 7200,
            "location": { "kind": "voice", "channel_id": s.voice }
        }),
    )
    .await;
    assert!(res.status().is_success(), "create: {}", res.status());
    let ev = only_event(&srv, &a, &s.id).await;
    assert_eq!(ev["ends_at"], start + 7200);
    assert_eq!(ev["location"]["kind"], "voice");
    assert_eq!(ev["location"]["channel_id"], s.voice.as_str());
    assert_eq!(ev["cancelled"], false);
    assert_eq!(ev["counts"]["going"], 1, "the host is going");
    assert_eq!(ev["me_status"], "going");
    assert_eq!(ev["going"][0]["id"], a.id.as_str());

    // A place of your own instead of a channel.
    let res = create(
        &srv,
        &a,
        &s.id,
        json!({
            "title": "Picnic",
            "starts_at": start + 86_400,
            "location": { "kind": "place", "text": "Dolores Park" }
        }),
    )
    .await;
    assert!(res.status().is_success());
    let events = list(&srv, &a, &s.id).await;
    let picnic = events.iter().find(|e| e["title"] == "Picnic").unwrap();
    assert_eq!(picnic["location"]["kind"], "place");
    assert_eq!(picnic["location"]["text"], "Dolores Park");
}

#[tokio::test]
async fn times_and_places_are_checked() {
    let srv = TestServer::start().await;
    let a = srv.register("evcheck", PASS).await;
    let s = space(&srv, &a, "Checks").await;
    let other = space(&srv, &a, "Elsewhere").await;
    let now = now_unix();
    let bad = [
        json!({ "title": "Past", "starts_at": now - 3600 }),
        json!({ "title": "Far", "starts_at": now + 3 * 365 * 86_400 }),
        json!({ "title": "Backwards", "starts_at": now + 3600, "ends_at": now + 1800 }),
        json!({ "title": "Elsewhere", "starts_at": now + 3600,
                "location": { "kind": "voice", "channel_id": other.voice } }),
        json!({ "title": "Wrong kind", "starts_at": now + 3600,
                "location": { "kind": "voice", "channel_id": s.general } }),
        json!({ "title": "Long place", "starts_at": now + 3600,
                "location": { "kind": "place", "text": "x".repeat(101) } }),
        json!({ "title": "Script", "starts_at": now + 3600,
                "location": { "kind": "place", "text": "javascript://alert(1)" } }),
    ];
    for body in bad {
        let res = create(&srv, &a, &s.id, body.clone()).await;
        assert_eq!(res.status(), 400, "{body}");
    }
    assert!(list(&srv, &a, &s.id).await.is_empty());
}

#[tokio::test]
async fn only_the_host_or_a_manager_edits_or_cancels() {
    let srv = TestServer::start().await;
    let a = srv.register("evowner", PASS).await;
    let b = srv.register("evmember", PASS).await;
    let s = space(&srv, &a, "Edits").await;
    join(&srv, &a, &s.id, &b).await;
    let start = now_unix() + 7200;
    assert!(create(
        &srv,
        &b,
        &s.id,
        json!({ "title": "B's thing", "starts_at": start })
    )
    .await
    .status()
    .is_success());
    let ev = only_event(&srv, &a, &s.id).await;
    let id = ev["id"].as_str().unwrap();

    // A plain member who didn't make it can't touch someone else's event…
    assert!(create(
        &srv,
        &a,
        &s.id,
        json!({ "title": "A's thing", "starts_at": start })
    )
    .await
    .status()
    .is_success());
    let a_event = list(&srv, &a, &s.id)
        .await
        .into_iter()
        .find(|e| e["title"] == "A's thing")
        .unwrap();
    let a_id = a_event["id"].as_str().unwrap();
    let res = srv
        .patch_json_auth(
            &format!("/api/v1/servers/{}/events/{a_id}", s.id),
            &b.token,
            json!({ "title": "Hijacked" }),
        )
        .await;
    assert_eq!(res.status(), 403);
    let res = srv
        .post_json_auth(
            &format!("/api/v1/servers/{}/events/{a_id}/cancel", s.id),
            &b.token,
            json!({}),
        )
        .await;
    assert_eq!(res.status(), 403);

    // …the host can edit theirs, and the owner (a manager) can edit anyone's.
    let res = srv
        .patch_json_auth(
            &format!("/api/v1/servers/{}/events/{id}", s.id),
            &b.token,
            json!({ "title": "B's renamed thing", "ends_at": start + 3600 }),
        )
        .await;
    assert!(res.status().is_success(), "host edit: {}", res.status());
    let res = srv
        .patch_json_auth(
            &format!("/api/v1/servers/{}/events/{id}", s.id),
            &a.token,
            json!({ "description": "Bring snacks" }),
        )
        .await;
    assert!(res.status().is_success(), "manager edit: {}", res.status());
    let edited = list(&srv, &a, &s.id)
        .await
        .into_iter()
        .find(|e| e["id"] == id)
        .unwrap();
    assert_eq!(edited["title"], "B's renamed thing");
    assert_eq!(edited["ends_at"], start + 3600);
    assert_eq!(edited["description"], "Bring snacks");
}

#[tokio::test]
async fn three_rsvp_answers_with_counts_and_the_old_toggle_still_works() {
    let srv = TestServer::start().await;
    let a = srv.register("evrsvpa", PASS).await;
    let b = srv.register("evrsvpb", PASS).await;
    let c = srv.register("evrsvpc", PASS).await;
    let s = space(&srv, &a, "RSVPs").await;
    join(&srv, &a, &s.id, &b).await;
    join(&srv, &a, &s.id, &c).await;
    assert!(create(
        &srv,
        &a,
        &s.id,
        json!({ "title": "Movie", "starts_at": now_unix() + 3600 })
    )
    .await
    .status()
    .is_success());
    let id = only_event(&srv, &a, &s.id).await["id"]
        .as_str()
        .unwrap()
        .to_owned();

    assert_eq!(rsvp(&srv, &b, &s.id, &id, json!("interested")).await, 204);
    let ev = only_event(&srv, &b, &s.id).await;
    assert_eq!(ev["counts"]["interested"], 1);
    assert_eq!(ev["me_status"], "interested");

    assert_eq!(rsvp(&srv, &b, &s.id, &id, json!("going")).await, 204);
    assert_eq!(rsvp(&srv, &c, &s.id, &id, json!("not_going")).await, 204);
    let ev = only_event(&srv, &a, &s.id).await;
    assert_eq!(ev["counts"]["going"], 2, "the host and B");
    assert_eq!(ev["counts"]["interested"], 0);
    assert_eq!(ev["counts"]["not_going"], 1);
    let going: Vec<&str> = ev["going"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u["id"].as_str().unwrap())
        .collect();
    assert!(
        going.contains(&b.id.as_str()) && going.contains(&a.id.as_str()),
        "who's going: {going:?}"
    );
    assert_eq!(
        ev["rsvp_count"], 2,
        "older apps read rsvp_count as the number going"
    );

    // Desktop 0.3.x posts with no body: it toggles Going, and reads rsvp_count / me_rsvp.
    let res = srv
        .post_empty_auth(
            &format!("/api/v1/servers/{}/events/{id}/rsvp", s.id),
            &c.token,
        )
        .await;
    assert_eq!(res.status(), 204);
    let ev = only_event(&srv, &c, &s.id).await;
    assert_eq!(ev["rsvp_count"], 3);
    assert_eq!(ev["me_rsvp"], true);
    assert_eq!(ev["me_status"], "going");
    assert_eq!(ev["counts"]["not_going"], 0);
    let res = srv
        .post_empty_auth(
            &format!("/api/v1/servers/{}/events/{id}/rsvp", s.id),
            &c.token,
        )
        .await;
    assert_eq!(res.status(), 204);
    let ev = only_event(&srv, &c, &s.id).await;
    assert_eq!(ev["me_rsvp"], false, "a second toggle takes it back");
    assert!(ev["me_status"].is_null());
    // Those apps label the empty body as JSON.
    let res = srv
        .post_raw_auth(
            &format!("/api/v1/servers/{}/events/{id}/rsvp", s.id),
            &c.token,
            "application/json",
            Vec::new(),
        )
        .await;
    assert_eq!(res.status(), 204);
    assert_eq!(only_event(&srv, &c, &s.id).await["me_rsvp"], true);
    let res = srv
        .post_raw_auth(
            &format!("/api/v1/servers/{}/events/{id}/rsvp", s.id),
            &c.token,
            "application/json",
            Vec::new(),
        )
        .await;
    assert_eq!(res.status(), 204);

    // Clearing an answer, and an answer that isn't one of the three.
    assert_eq!(rsvp(&srv, &b, &s.id, &id, Value::Null).await, 204);
    assert_eq!(only_event(&srv, &a, &s.id).await["counts"]["going"], 1);
    assert_eq!(rsvp(&srv, &c, &s.id, &id, json!("maybe")).await, 400);
}

#[tokio::test]
async fn a_cover_is_an_image_you_uploaded() {
    let srv = TestServer::start().await;
    let a = srv.register("evcovera", PASS).await;
    let b = srv.register("evcoverb", PASS).await;
    let s = space(&srv, &a, "Covers").await;
    join(&srv, &a, &s.id, &b).await;
    let mine = upload_png(&srv, &a).await;
    let theirs = upload_png(&srv, &b).await;
    let start = now_unix() + 3600;
    let res = create(
        &srv,
        &a,
        &s.id,
        json!({ "title": "Borrowed", "starts_at": start, "cover_file_id": theirs }),
    )
    .await;
    assert_eq!(res.status(), 400, "someone else's upload");
    let res = create(
        &srv,
        &a,
        &s.id,
        json!({ "title": "Mine", "starts_at": start, "cover_file_id": mine }),
    )
    .await;
    assert!(res.status().is_success(), "own upload: {}", res.status());
    let ev = only_event(&srv, &a, &s.id).await;
    assert!(
        ev["cover_url"].as_str().is_some_and(|u| u.contains(&mine)),
        "{}",
        ev["cover_url"]
    );
}

/// A real 1×1 PNG, uploaded by `who`; returns the file id.
async fn upload_png(srv: &TestServer, who: &AuthOk) -> String {
    const PNG: &str = "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6300010000000500010d0a2db40000000049454e44ae426082";
    let bytes: Vec<u8> = (0..PNG.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&PNG[i..i + 2], 16).unwrap())
        .collect();
    let (content_type, body) = common::multipart_file("file", "cover.png", "image/png", &bytes);
    let res = srv
        .post_raw_auth("/api/v1/upload", &who.token, &content_type, body)
        .await;
    assert_eq!(res.status(), 200, "upload");
    let files: Value = res.json().await.unwrap();
    files[0]["id"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn cancelling_tells_the_people_who_answered() {
    let srv = TestServer::start().await;
    let a = srv.register("evcanca", PASS).await;
    let b = srv.register("evcancb", PASS).await;
    let c = srv.register("evcancc", PASS).await;
    let s = space(&srv, &a, "Cancel").await;
    join(&srv, &a, &s.id, &b).await;
    join(&srv, &a, &s.id, &c).await;
    push_device(&srv, &b, "cancel-b").await;
    push_device(&srv, &c, "cancel-c").await;
    assert!(create(
        &srv,
        &a,
        &s.id,
        json!({ "title": "Raid", "starts_at": now_unix() + 7200 })
    )
    .await
    .status()
    .is_success());
    let id = only_event(&srv, &a, &s.id).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(rsvp(&srv, &b, &s.id, &id, json!("going")).await, 204);

    let res = srv
        .post_json_auth(
            &format!("/api/v1/servers/{}/events/{id}/cancel", s.id),
            &a.token,
            json!({}),
        )
        .await;
    assert!(res.status().is_success(), "cancel: {}", res.status());
    assert_eq!(only_event(&srv, &a, &s.id).await["cancelled"], true);
    assert_eq!(
        event_pushes(&srv, &b).await,
        1,
        "the person going hears about it"
    );
    assert_eq!(
        event_pushes(&srv, &c).await,
        0,
        "someone who never answered doesn't"
    );
    // A cancelled event can't be answered any more.
    assert_eq!(rsvp(&srv, &c, &s.id, &id, json!("going")).await, 409);
}

#[tokio::test]
async fn reminders_go_once_at_fifteen_minutes_and_once_at_the_start() {
    let srv = TestServer::start().await;
    let a = srv.register("evremha", PASS).await;
    let b = srv.register("evremhb", PASS).await;
    let c = srv.register("evremhc", PASS).await;
    let d = srv.register("evremhd", PASS).await;
    let s = space(&srv, &a, "Reminders").await;
    for who in [&b, &c, &d] {
        join(&srv, &a, &s.id, who).await;
    }
    push_device(&srv, &b, "rem-b").await;
    push_device(&srv, &c, "rem-c").await;
    push_device(&srv, &d, "rem-d").await;
    let now = now_unix();
    let start = now + 600; // ten minutes away: inside the 15-minute window already
    assert!(create(
        &srv,
        &a,
        &s.id,
        json!({ "title": "Soon", "starts_at": start })
    )
    .await
    .status()
    .is_success());
    let id = only_event(&srv, &a, &s.id).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(rsvp(&srv, &b, &s.id, &id, json!("going")).await, 204);
    assert_eq!(rsvp(&srv, &c, &s.id, &id, json!("interested")).await, 204);
    assert_eq!(rsvp(&srv, &d, &s.id, &id, json!("not_going")).await, 204);

    server::api::events::send_due_reminders(&srv.state, now).await;
    assert_eq!(event_pushes(&srv, &b).await, 1);
    assert_eq!(event_pushes(&srv, &c).await, 1);
    assert_eq!(event_pushes(&srv, &d).await, 0, "Can't go hears nothing");
    server::api::events::send_due_reminders(&srv.state, now + 30).await;
    assert_eq!(
        event_pushes(&srv, &b).await,
        1,
        "the 15-minute reminder goes once"
    );
    // The relay sends that nudge; a device takes a new one once nothing is waiting.
    sqlx::query("UPDATE push_deliveries SET status = 'delivered'")
        .execute(&srv.state.db)
        .await
        .unwrap();

    server::api::events::send_due_reminders(&srv.state, start + 5).await;
    assert_eq!(
        event_pushes(&srv, &b).await,
        2,
        "and once more at the start"
    );
    assert_eq!(event_pushes(&srv, &c).await, 2);
    server::api::events::send_due_reminders(&srv.state, start + 40).await;
    assert_eq!(
        event_pushes(&srv, &b).await,
        2,
        "the start reminder goes once"
    );
}

#[tokio::test]
async fn reminders_respect_a_silenced_space() {
    let srv = TestServer::start().await;
    let a = srv.register("evsila", PASS).await;
    let b = srv.register("evsilb", PASS).await;
    let c = srv.register("evsilc", PASS).await;
    let s = space(&srv, &a, "Quiet").await;
    join(&srv, &a, &s.id, &b).await;
    join(&srv, &a, &s.id, &c).await;
    push_device(&srv, &b, "sil-b").await;
    push_device(&srv, &c, "sil-c").await;
    let res = srv
        .put_json_auth(
            &format!("/api/v1/users/@me/notification-settings/server/{}", s.id),
            &b.token,
            json!({ "level": "nothing", "muted": false }),
        )
        .await;
    assert!(res.status().is_success());
    let res = srv
        .put_json_auth(
            &format!("/api/v1/users/@me/notification-settings/server/{}", s.id),
            &c.token,
            json!({ "muted": true }),
        )
        .await;
    assert!(res.status().is_success());
    let now = now_unix();
    assert!(create(
        &srv,
        &a,
        &s.id,
        json!({ "title": "Hush", "starts_at": now + 300 })
    )
    .await
    .status()
    .is_success());
    let id = only_event(&srv, &a, &s.id).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(rsvp(&srv, &b, &s.id, &id, json!("going")).await, 204);
    assert_eq!(rsvp(&srv, &c, &s.id, &id, json!("going")).await, 204);

    server::api::events::send_due_reminders(&srv.state, now).await;
    assert_eq!(
        event_pushes(&srv, &b).await,
        0,
        "a space set to Nothing stays silent"
    );
    assert_eq!(
        event_pushes(&srv, &c).await,
        0,
        "a muted space stays silent"
    );
}

#[tokio::test]
async fn a_start_reminder_missed_by_a_long_outage_is_dropped() {
    let srv = TestServer::start().await;
    let a = srv.register("evstalea", PASS).await;
    let b = srv.register("evstaleb", PASS).await;
    let s = space(&srv, &a, "Stale").await;
    join(&srv, &a, &s.id, &b).await;
    push_device(&srv, &b, "stale-b").await;
    let now = now_unix();
    assert!(create(
        &srv,
        &a,
        &s.id,
        json!({ "title": "Earlier", "starts_at": now + 3600 })
    )
    .await
    .status()
    .is_success());
    let id = only_event(&srv, &a, &s.id).await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(rsvp(&srv, &b, &s.id, &id, json!("going")).await, 204);

    // The server was down from before the 15-minute mark until an hour after the start.
    server::api::events::send_due_reminders(&srv.state, now + 3600 + 3600).await;
    assert_eq!(
        event_pushes(&srv, &b).await,
        0,
        "no reminder for an event long started"
    );
}
