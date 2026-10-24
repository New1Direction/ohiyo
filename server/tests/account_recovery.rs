//! Public HTTP account-recovery regressions on isolated, file-backed migrated databases.
mod common;

use common::{ws::Gateway, TestServer};
use serde_json::{json, Value};
use std::{net::SocketAddr, time::Duration};

const MANAGE: &str = "/api/v1/users/@me/account-recovery";
const RECOVER: &str = "/api/v1/auth/recover";
const PASS: &str = "original-password-47";
const NEW: &str = "replacement-password-83";

async fn issue(srv: &TestServer, token: &str, second: Option<&str>) -> String {
    let res = srv
        .post_json_auth(
            MANAGE,
            token,
            json!({"password": PASS, "two_factor_code": second}),
        )
        .await;
    assert_eq!(res.status(), 200, "{}", res.text().await.unwrap());
    assert_eq!(res.headers()["cache-control"], "no-store");
    let value: Value = res.json().await.unwrap();
    let code = value["recovery_code"].as_str().unwrap();
    assert_eq!(code.len(), 43, "32 random bytes as unpadded base64url");
    assert_eq!(value.as_object().unwrap().len(), 1);
    code.to_owned()
}

async fn recover(
    srv: &TestServer,
    username: &str,
    code: &str,
    password: &str,
) -> reqwest::Response {
    srv.post_json(
        RECOVER,
        json!({"username":username,"recovery_code":code,"new_password":password}),
    )
    .await
}

async fn login(srv: &TestServer, username: &str, password: &str) -> reqwest::Response {
    srv.post_json(
        "/api/v1/auth/login",
        json!({"username":username,"password":password}),
    )
    .await
}

async fn enabled(srv: &TestServer, token: &str) -> bool {
    let res = srv.get_auth(MANAGE, token).await;
    assert_eq!(res.status(), 200);
    let value: Value = res.json().await.unwrap();
    assert_eq!(
        value.as_object().unwrap().len(),
        1,
        "status never returns a secret"
    );
    value["enabled"].as_bool().unwrap()
}

#[tokio::test]
async fn reset_consumes_code_revokes_tokens_links_and_sockets_but_preserves_chat_backup() {
    let srv = TestServer::start().await;
    let me = srv.register("RecoverMixed", PASS).await;
    let other = srv.register("unaffected", PASS).await;
    assert!(!enabled(&srv, &me.token).await);
    let backup = json!({"v":1,"ciphertext":"opaque-distinct-chat-key-backup"});
    assert_eq!(
        srv.put_json_auth(
            "/api/v1/users/@me/key-backup",
            &me.token,
            json!({"password":PASS,"backup":backup})
        )
        .await
        .status(),
        204
    );
    let code = issue(&srv, &me.token, None).await;
    assert!(enabled(&srv, &me.token).await);
    let link: Value = srv
        .post_empty_auth("/api/v1/devices/link/start", &me.token)
        .await
        .json()
        .await
        .unwrap();
    let mut ws = Gateway::connect(&srv, &me.token).await;

    let res = recover(&srv, "recovermixed", &code, NEW).await;
    assert_eq!(res.status(), 204);
    assert!(res.bytes().await.unwrap().is_empty(), "no token or session");
    ws.wait_closed().await;
    assert_eq!(
        srv.get_auth("/api/v1/users/@me", &me.token).await.status(),
        401
    );
    assert_eq!(
        srv.post_json_auth(MANAGE, &me.token, json!({"password":NEW}))
            .await
            .status(),
        401
    );
    assert_eq!(
        srv.post_empty_auth("/api/v1/devices/link/start", &me.token)
            .await
            .status(),
        401
    );
    assert_eq!(
        srv.post_json(
            "/api/v1/devices/link/complete",
            json!({"code":link["code"]})
        )
        .await
        .status(),
        404
    );
    assert_eq!(login(&srv, "RecoverMixed", PASS).await.status(), 401);
    let signed: Value = login(&srv, "RecoverMixed", NEW).await.json().await.unwrap();
    let token = signed["token"].as_str().unwrap();
    assert!(!enabled(&srv, token).await);
    let preserved: Value = srv
        .get_auth("/api/v1/users/@me/key-backup", token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(preserved, backup);
    assert_eq!(
        srv.get_auth("/api/v1/users/@me", &other.token)
            .await
            .status(),
        200
    );
    assert_eq!(
        recover(&srv, "RecoverMixed", &code, "not-the-new-password")
            .await
            .status(),
        401
    );
    assert_eq!(login(&srv, "RecoverMixed", NEW).await.status(), 200);
}

#[tokio::test]
async fn wrong_other_user_absent_and_replaced_codes_have_identical_errors_and_do_not_consume() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice_recovery", PASS).await;
    let bob = srv.register("bob_recovery", PASS).await;
    srv.register("no_recovery", PASS).await;
    let old = issue(&srv, &alice.token, None).await;
    let code = issue(&srv, &alice.token, None).await;
    let bobs_code = issue(&srv, &bob.token, None).await;
    assert_ne!(old, code);
    for (user, candidate) in [
        ("alice_recovery", "wrong"),
        ("alice_recovery", old.as_str()),
        ("bob_recovery", code.as_str()),
        ("no_recovery", code.as_str()),
        ("absent_recovery", code.as_str()),
        ("alice_recovery", bobs_code.as_str()),
    ] {
        let res = recover(&srv, user, candidate, NEW).await;
        assert_eq!(res.status(), 401);
        assert_eq!(res.text().await.unwrap(), "invalid credentials");
    }
    assert_eq!(
        recover(&srv, "alice_recovery", &code, NEW).await.status(),
        204
    );
    assert_eq!(
        recover(&srv, "bob_recovery", &bobs_code, "bobs-new-password")
            .await
            .status(),
        204
    );
}

#[tokio::test]
async fn issuing_requires_password_and_session_and_is_step_up_limited() {
    let srv = TestServer::start().await;
    let me = srv.register("stepup", PASS).await;
    assert_eq!(
        srv.post_json(MANAGE, json!({"password":PASS}))
            .await
            .status(),
        401
    );
    assert_eq!(
        srv.client
            .get(srv.url(MANAGE))
            .send()
            .await
            .unwrap()
            .status(),
        401
    );
    for _ in 0..5 {
        assert_eq!(
            srv.post_json_auth(MANAGE, &me.token, json!({"password":"wrong"}))
                .await
                .status(),
            403
        );
    }
    assert_eq!(
        srv.post_json_auth(MANAGE, &me.token, json!({"password":PASS}))
            .await
            .status(),
        429
    );
    assert!(!enabled(&srv, &me.token).await);
}

#[tokio::test]
async fn ordinary_password_change_invalidates_recovery_but_failed_change_does_not() {
    let srv = TestServer::start().await;
    let me = srv.register("change_invalidate", PASS).await;
    let code = issue(&srv, &me.token, None).await;
    assert_eq!(
        srv.post_json_auth(
            "/api/v1/auth/password",
            &me.token,
            json!({"current_password":"wrong", "new_password":NEW})
        )
        .await
        .status(),
        403
    );
    assert!(enabled(&srv, &me.token).await);
    let res = srv
        .post_json_auth(
            "/api/v1/auth/password",
            &me.token,
            json!({"current_password":PASS, "new_password":NEW}),
        )
        .await;
    assert_eq!(res.status(), 200);
    let signed: Value = res.json().await.unwrap();
    assert!(!enabled(&srv, signed["token"].as_str().unwrap()).await);
    assert_eq!(
        recover(&srv, "change_invalidate", &code, PASS)
            .await
            .status(),
        401
    );
    assert_eq!(login(&srv, "change_invalidate", NEW).await.status(), 200);
}

#[tokio::test]
async fn only_hash_persists_and_a_fresh_application_can_redeem_it() {
    let srv = TestServer::start().await;
    let me = srv.register("persistent", PASS).await;
    let code = issue(&srv, &me.token, None).await;
    let hash: String =
        sqlx::query_scalar("SELECT code_hash FROM account_recovery WHERE user_id = ?")
            .bind(&me.id)
            .fetch_one(&srv.state.db)
            .await
            .unwrap();
    assert_eq!(hash.len(), 64);
    assert!(!hash.contains(&code));
    // Search the actual SQLite file and its WAL, not just the selected column.
    sqlx::query("PRAGMA wal_checkpoint(FULL)")
        .execute(&srv.state.db)
        .await
        .unwrap();
    let path = srv.db_url().strip_prefix("sqlite:").unwrap();
    for suffix in ["", "-wal"] {
        if let Ok(bytes) = std::fs::read(format!("{path}{suffix}")) {
            assert!(!bytes.windows(code.len()).any(|w| w == code.as_bytes()));
        }
    }
    // Close the original pool, then rebuild all state and routes against the same file.
    srv.state.db.close().await;
    let pool = server::db::connect(srv.db_url()).await.unwrap();
    let mut state = server::build_state(pool.clone());
    state.min_free_disk_bytes = 0;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(
            listener,
            server::build_app(state).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let res = srv
        .client
        .post(format!("http://{addr}{RECOVER}"))
        .json(&json!({"username":"persistent","recovery_code":code,"new_password":NEW}))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM account_recovery")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    task.abort();
    pool.close().await;
}

#[tokio::test]
async fn concurrent_consumers_have_exactly_one_winner_and_only_its_password_works() {
    let srv = TestServer::start().await;
    let me = srv.register("concurrent", PASS).await;
    let code = issue(&srv, &me.token, None).await;
    let (a, b) = tokio::join!(
        recover(&srv, "concurrent", &code, "winner-candidate-A"),
        recover(&srv, "concurrent", &code, "winner-candidate-B"),
    );
    let statuses = [a.status().as_u16(), b.status().as_u16()];
    assert!(
        statuses == [204, 401] || statuses == [401, 204],
        "{statuses:?}"
    );
    for (index, password) in ["winner-candidate-A", "winner-candidate-B"]
        .iter()
        .enumerate()
    {
        assert_eq!(
            login(&srv, "concurrent", password).await.status().as_u16(),
            if statuses[index] == 204 { 200 } else { 401 }
        );
    }
    let version: i64 = sqlx::query_scalar("SELECT token_version FROM users WHERE id = ?")
        .bind(&me.id)
        .fetch_one(&srv.state.db)
        .await
        .unwrap();
    assert_eq!(version, 1);
}

#[tokio::test]
async fn recovery_and_password_change_cannot_overwrite_each_others_winner() {
    let srv = TestServer::start().await;
    let me = srv.register("password_race", PASS).await;
    let code = issue(&srv, &me.token, None).await;
    let (reset, change) = tokio::join!(
        recover(&srv, "password_race", &code, NEW),
        srv.post_json_auth(
            "/api/v1/auth/password",
            &me.token,
            json!({"current_password":PASS,"new_password":"ordinary-change-password"})
        ),
    );
    assert!(matches!(reset.status().as_u16(), 204 | 401));
    assert!(matches!(change.status().as_u16(), 200 | 401 | 403));
    assert_ne!(reset.status().is_success(), change.status().is_success());
    let expected = if reset.status().is_success() {
        NEW
    } else {
        "ordinary-change-password"
    };
    assert_eq!(login(&srv, "password_race", expected).await.status(), 200);
    let version: i64 = sqlx::query_scalar("SELECT token_version FROM users WHERE id = ?")
        .bind(&me.id)
        .fetch_one(&srv.state.db)
        .await
        .unwrap();
    assert_eq!(version, 1);
}

#[tokio::test]
async fn rotation_and_consumption_cannot_both_commit_and_the_surviving_code_is_exact() {
    let srv = TestServer::start().await;
    let me = srv.register("rotation_race", PASS).await;
    let code = issue(&srv, &me.token, None).await;
    let (reset, rotation) = tokio::join!(
        recover(&srv, "rotation_race", &code, NEW),
        srv.post_json_auth(MANAGE, &me.token, json!({"password":PASS})),
    );
    let statuses = [reset.status().as_u16(), rotation.status().as_u16()];
    // If reset wins before require_password reads, the old password gets 403;
    // if it wins after password verification, the generation check gets 401.
    assert!(
        matches!(statuses, [204, 401 | 403] | [401, 200]),
        "{statuses:?}"
    );
    if rotation.status().is_success() {
        let body: Value = rotation.json().await.unwrap();
        let fresh = body["recovery_code"].as_str().unwrap();
        assert_ne!(code, fresh);
        assert_eq!(
            recover(&srv, "rotation_race", &code, NEW).await.status(),
            401
        );
        assert_eq!(
            recover(&srv, "rotation_race", fresh, NEW).await.status(),
            204
        );
    }
    assert_eq!(login(&srv, "rotation_race", NEW).await.status(), 200);
    assert_eq!(login(&srv, "rotation_race", PASS).await.status(), 401);
}

#[tokio::test]
async fn logging_out_preserves_the_user_held_code_but_revokes_issuance_authority() {
    let srv = TestServer::start().await;
    let me = srv.register("logout_recover", PASS).await;
    let code = issue(&srv, &me.token, None).await;
    assert_eq!(
        srv.post_empty_auth("/api/v1/auth/logout-everywhere", &me.token)
            .await
            .status(),
        204
    );
    assert_eq!(
        srv.post_json_auth(MANAGE, &me.token, json!({"password":PASS}))
            .await
            .status(),
        401
    );
    assert_eq!(
        recover(&srv, "logout_recover", &code, NEW).await.status(),
        204
    );
    assert_eq!(login(&srv, "logout_recover", NEW).await.status(), 200);
}

#[tokio::test]
async fn per_account_limit_normalizes_case_and_also_limits_unknown_accounts() {
    let srv = TestServer::start_with(|s| s.login_limit_per_username_per_minute = 3).await;
    let me = srv.register("LimitedRecovery", PASS).await;
    let code = issue(&srv, &me.token, None).await;
    for name in ["LimitedRecovery", "limitedrecovery", "LIMITEDRECOVERY"] {
        assert_eq!(recover(&srv, name, "wrong", NEW).await.status(), 401);
    }
    assert_eq!(
        recover(&srv, "LimitedRecovery", &code, NEW).await.status(),
        429
    );
    for _ in 0..3 {
        assert_eq!(recover(&srv, "absent", "wrong", NEW).await.status(), 401);
    }
    assert_eq!(recover(&srv, "ABSENT", "wrong", NEW).await.status(), 429);
    assert_eq!(recover(&srv, "different", "wrong", NEW).await.status(), 401);
}

#[tokio::test]
async fn address_cap_is_shared_with_login_and_ignores_untrusted_forwarded_headers() {
    let srv = TestServer::start().await;
    // No environment mutation: CI/test command uses no proxy trust configuration.
    for i in 0..40 {
        let res = srv.client.post(srv.url(RECOVER))
            .header("x-forwarded-for", format!("198.51.100.{i}"))
            .header("fly-client-ip", format!("198.51.100.{i}"))
            .json(&json!({"username":format!("absent{i}"),"recovery_code":"wrong","new_password":NEW}))
            .send().await.unwrap();
        assert_eq!(res.status(), 401);
    }
    assert_eq!(recover(&srv, "fresh", "wrong", NEW).await.status(), 429);
    assert_eq!(login(&srv, "fresh", PASS).await.status(), 429);
}

#[tokio::test]
async fn bounds_reject_without_consuming_the_correct_code() {
    let srv = TestServer::start().await;
    let me = srv.register("bounded", PASS).await;
    let code = issue(&srv, &me.token, None).await;
    for password in ["short".to_owned(), "x".repeat(1025)] {
        assert_eq!(
            recover(&srv, "bounded", &code, &password).await.status(),
            400
        );
    }
    assert_eq!(
        recover(&srv, &"u".repeat(33), &code, NEW).await.status(),
        401
    );
    assert_eq!(
        recover(&srv, "bounded", &"x".repeat(129), NEW)
            .await
            .status(),
        401
    );
    assert_eq!(
        srv.post_json_auth(
            MANAGE,
            &me.token,
            json!({"password":PASS,"two_factor_code":"p".repeat(129)})
        )
        .await
        .status(),
        400
    );
    assert_eq!(recover(&srv, "bounded", &code, NEW).await.status(), 204);
}

#[tokio::test]
async fn second_factor_is_required_preserved_and_pending_challenges_are_revoked() {
    use server::auth::two_factor::{base32_decode, code_for_step, step_at};
    let srv = TestServer::start().await;
    let me = srv.register("factor_recovery", PASS).await;
    let setup: Value = srv
        .post_json_auth(
            "/api/v1/users/@me/two-factor/setup",
            &me.token,
            json!({"password":PASS}),
        )
        .await
        .json()
        .await
        .unwrap();
    let secret = base32_decode(setup["secret"].as_str().unwrap()).unwrap();
    let enabled = srv
        .post_json_auth(
            "/api/v1/users/@me/two-factor/enable",
            &me.token,
            json!({"code":code_for_step(&secret,step_at(common::now_unix()))}),
        )
        .await;
    assert_eq!(enabled.status(), 200);
    let backup_codes: Value = enabled.json().await.unwrap();
    let codes = backup_codes["recovery_codes"].as_array().unwrap();
    assert_eq!(
        srv.post_json_auth(MANAGE, &me.token, json!({"password":PASS}))
            .await
            .status(),
        403
    );
    let code = issue(&srv, &me.token, codes[0].as_str()).await;
    let before: (Vec<u8>, i64, i64) = sqlx::query_as(
        "SELECT secret_enc, enabled_at, last_step FROM two_factor WHERE user_id = ?",
    )
    .bind(&me.id)
    .fetch_one(&srv.state.db)
    .await
    .unwrap();
    let pending: Value = login(&srv, "factor_recovery", PASS)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(
        recover(&srv, "factor_recovery", &code, NEW).await.status(),
        401
    );
    assert_eq!(
        srv.post_json(
            RECOVER,
            json!({"username":"factor_recovery","recovery_code":code,
        "new_password":NEW,"two_factor_code":"wrong"})
        )
        .await
        .status(),
        401
    );
    // A 2FA backup code is NOT an account recovery code.
    assert_eq!(
        recover(&srv, "factor_recovery", codes[2].as_str().unwrap(), NEW)
            .await
            .status(),
        401
    );
    let res = srv
        .post_json(
            RECOVER,
            json!({"username":"factor_recovery","recovery_code":code,
        "new_password":NEW,"two_factor_code":codes[1]}),
        )
        .await;
    assert_eq!(res.status(), 204);
    let after: (Vec<u8>, i64, i64) = sqlx::query_as(
        "SELECT secret_enc, enabled_at, last_step FROM two_factor WHERE user_id = ?",
    )
    .bind(&me.id)
    .fetch_one(&srv.state.db)
    .await
    .unwrap();
    assert_eq!(
        before, after,
        "2FA remains enabled with exactly the same secret"
    );
    let remaining: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM two_factor_recovery_codes WHERE user_id = ? AND used_at IS NULL",
    )
    .bind(&me.id)
    .fetch_one(&srv.state.db)
    .await
    .unwrap();
    assert_eq!(
        remaining, 8,
        "only the two explicit step-ups consume 2FA backup codes"
    );
    assert_eq!(
        srv.post_json(
            "/api/v1/auth/login/two-factor",
            json!({"challenge":pending["challenge"],"code":codes[2]})
        )
        .await
        .status(),
        401
    );
    let login: Value = login(&srv, "factor_recovery", NEW)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(login["two_factor_required"], true);
    assert!(login.get("token").is_none());
    assert_eq!(
        srv.post_json(
            "/api/v1/auth/login/two-factor",
            json!({"challenge":login["challenge"],"code":codes[2]})
        )
        .await
        .status(),
        200
    );
}

/// Hold SQLite's writer while HTTP authenticates and performs step-up. Once the
/// request reaches its existing authenticated rate key, revocation commits first.
#[tokio::test]
async fn already_authenticated_issuance_cannot_outlive_session_revocation() {
    let srv = TestServer::start().await;
    let me = srv.register("issue_race", PASS).await;
    let mut tx = srv.state.db.begin_with("BEGIN IMMEDIATE").await.unwrap();
    let client = srv.client.clone();
    let url = srv.url(MANAGE);
    let token = me.token.clone();
    let issuing = tokio::spawn(async move {
        client
            .post(url)
            .bearer_auth(token)
            .json(&json!({"password":PASS}))
            .send()
            .await
            .unwrap()
    });
    tokio::time::timeout(Duration::from_secs(10), async {
        while srv.state.rate.tracked_user_keys() == 0 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    sqlx::query("UPDATE users SET token_version = token_version + 1 WHERE id = ?")
        .bind(&me.id)
        .execute(&mut *tx)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(issuing.await.unwrap().status(), 401);
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM account_recovery WHERE user_id = ?")
        .bind(&me.id)
        .fetch_one(&srv.state.db)
        .await
        .unwrap();
    assert_eq!(count, 0);
}

#[tokio::test]
async fn an_existing_long_password_still_verifies_for_issuance_and_password_change() {
    let srv = TestServer::start().await;
    let me = srv.register("legacy_long_password", PASS).await;
    let long = "legacy-".repeat(300);
    // Model a password registered before the new-password cap. Do not grandfather by
    // name, creation date or hash parameters: every existing hash must still verify.
    let hash = server::auth::hash_password(&long).unwrap();
    sqlx::query("UPDATE users SET password_hash = ? WHERE id = ?")
        .bind(hash)
        .bind(&me.id)
        .execute(&srv.state.db)
        .await
        .unwrap();
    assert_eq!(
        login(&srv, "legacy_long_password", &long).await.status(),
        200
    );
    assert_eq!(
        srv.post_json_auth(MANAGE, &me.token, json!({"password":long}))
            .await
            .status(),
        200
    );
    assert_eq!(
        srv.post_json_auth(
            "/api/v1/auth/password",
            &me.token,
            json!({"current_password":long,"new_password":NEW})
        )
        .await
        .status(),
        200
    );
    assert_eq!(login(&srv, "legacy_long_password", NEW).await.status(), 200);
}

#[tokio::test]
async fn registration_applies_the_same_new_password_cap_as_reset_and_change() {
    let srv = TestServer::start().await;
    assert_eq!(
        srv.post_json(
            "/api/v1/auth/register",
            json!({"username":"long_new_password","password":"x".repeat(1025)})
        )
        .await
        .status(),
        400
    );
    assert_eq!(
        srv.post_json(
            "/api/v1/auth/register",
            json!({"username":"max_new_password","password":"x".repeat(1024)})
        )
        .await
        .status(),
        200
    );
}
