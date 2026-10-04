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

#[tokio::test]
async fn category_names_are_capped_at_100_characters() {
    let srv = TestServer::start().await;
    let owner = srv.register("limitowner", "password123").await;
    let server_id = create_server(&srv, &owner).await;
    for (name, status) in [(chars(101), 400), (chars(100), 200)] {
        let res = srv
            .post_json_auth(
                &format!("/api/v1/servers/{server_id}/categories"),
                &owner.token,
                json!({ "name": name }),
            )
            .await;
        assert_eq!(res.status(), status);
    }
}

#[tokio::test]
async fn group_dm_names_are_capped_at_100_characters() {
    let srv = TestServer::start().await;
    let alice = srv.register("limitalice", "password123").await;
    let bob = srv.register("limitbob", "password123").await;
    for (name, status) in [(chars(101), 400), (chars(100), 200)] {
        let res = srv
            .post_json_auth(
                "/api/v1/users/@me/group-dms",
                &alice.token,
                json!({ "recipient_ids": [bob.id], "name": name }),
            )
            .await;
        assert_eq!(res.status(), status);
    }
}

#[tokio::test]
async fn pronouns_are_capped_at_40_characters_and_custom_status_at_128() {
    let srv = TestServer::start().await;
    let alice = srv.register("limitalice", "password123").await;
    for (field, max) in [("pronouns", 40), ("custom_status", 128)] {
        for (value, status) in [(chars(max + 1), 400), (chars(max), 200)] {
            let mut body = serde_json::Map::new();
            body.insert(field.to_owned(), json!(value));
            let res = srv
                .patch_json_auth("/api/v1/users/@me/profile", &alice.token, body.into())
                .await;
            assert_eq!(res.status(), status, "{field}");
        }
    }
}

/// Emoji names were already capped at 32 bytes, which is never more than 32 characters,
/// so that stricter cap stays: 17 two-byte characters (34 bytes) are refused too.
#[tokio::test]
async fn emoji_names_keep_their_existing_32_byte_cap() {
    let srv = TestServer::start().await;
    let owner = srv.register("limitowner", "password123").await;
    let server_id = create_server(&srv, &owner).await;
    for name in ["a".repeat(33), chars(17)] {
        let res = srv
            .post_json_auth(
                &format!("/api/v1/servers/{server_id}/emojis"),
                &owner.token,
                json!({ "name": name, "file_id": "none" }),
            )
            .await;
        assert_eq!(res.status(), 400, "{name}");
    }
}

#[tokio::test]
async fn banner_colors_are_capped_at_32_characters_and_social_fields_at_200() {
    let srv = TestServer::start().await;
    let alice = srv.register("limitalice", "password123").await;
    let fields = [
        ("banner_color", 32),
        ("social_spotify", 200),
        ("social_github", 200),
        ("social_twitter", 200),
        ("social_steam", 200),
        ("social_youtube", 200),
        ("social_twitch", 200),
    ];
    for (field, max) in fields {
        for (value, status) in [(chars(max + 1), 400), (chars(max), 200)] {
            let mut body = serde_json::Map::new();
            body.insert(field.to_owned(), json!(value));
            let res = srv
                .patch_json_auth("/api/v1/users/@me/profile", &alice.token, body.into())
                .await;
            assert_eq!(res.status(), status, "{field}");
        }
    }
}

/// The profile theme is stored as its JSON text; that text is capped at 16 KiB worth of
/// characters. `{"note":"…"}` is the note plus 11 characters.
#[tokio::test]
async fn profile_themes_are_capped_at_16_kib_of_json() {
    let srv = TestServer::start().await;
    let alice = srv.register("limitalice", "password123").await;
    let theme = |note_chars: usize| json!({ "note": chars(note_chars) });
    let max = 16 * 1024;

    let res = srv
        .patch_json_auth(
            "/api/v1/users/@me/profile",
            &alice.token,
            json!({ "bio": "should not be saved", "profile_theme": theme(max - 11 + 1) }),
        )
        .await;
    assert_eq!(res.status(), 400);
    let profile: Value = srv
        .get_auth("/api/v1/users/@me/profile", &alice.token)
        .await
        .json()
        .await
        .unwrap();
    assert!(profile["bio"].is_null(), "a refused update writes nothing");

    let res = srv
        .patch_json_auth(
            "/api/v1/users/@me/profile",
            &alice.token,
            json!({ "profile_theme": theme(max - 11) }),
        )
        .await;
    assert_eq!(res.status(), 200);
}

#[tokio::test]
async fn bios_are_capped_at_500_characters() {
    let srv = TestServer::start().await;
    let alice = srv.register("limitalice", "password123").await;
    for (bio, status) in [(chars(501), 400), (chars(500), 200)] {
        let res = srv
            .patch_json_auth(
                "/api/v1/users/@me/profile",
                &alice.token,
                json!({ "bio": bio }),
            )
            .await;
        assert_eq!(res.status(), status);
    }
}
