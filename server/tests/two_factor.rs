//! Two-factor sign-in with an authenticator app. Turning it on needs the password and a
//! working code; then signing in needs a code (or a single-use recovery code) after the
//! password, a code works once, and turning it off, changing the password or deleting the
//! account need a code too. Wrong codes are held to 5 a minute and 20 an hour per account,
//! however many sign-ins they're spread over. The secret is stored encrypted, and a server with
//! no key to encrypt it with doesn't offer two-factor sign-in at all.

mod common;

use std::time::Duration;

use common::{ws::Gateway, AuthOk, TestServer};
use serde_json::{json, Value};
use server::auth::two_factor::{base32_decode, code_for_step, step_at};
use sha2::{Digest, Sha256};

const PASS: &str = "two-factor-pass-1";

fn now() -> i64 {
    common::now_unix()
}

/// Wait until the current 30-second step has a few seconds left, so a code worked out now is
/// still from the same step when the server checks it.
async fn away_from_step_edge() {
    let into = now().rem_euclid(30);
    if into >= 25 {
        tokio::time::sleep(Duration::from_secs((31 - into) as u64)).await;
    }
}

async fn status(srv: &TestServer, token: &str) -> Value {
    let res = srv.get_auth("/api/v1/users/@me/two-factor", token).await;
    assert_eq!(res.status(), 200);
    res.json().await.unwrap()
}

async fn setup(srv: &TestServer, token: &str) -> (Vec<u8>, Value) {
    let res = srv
        .post_json_auth(
            "/api/v1/users/@me/two-factor/setup",
            token,
            json!({ "password": PASS }),
        )
        .await;
    assert_eq!(res.status(), 200, "setup");
    let body: Value = res.json().await.unwrap();
    let secret = base32_decode(body["secret"].as_str().expect("secret")).expect("base32 secret");
    (secret, body)
}

async fn enable(srv: &TestServer, token: &str, code: &str) -> reqwest::Response {
    srv.post_json_auth(
        "/api/v1/users/@me/two-factor/enable",
        token,
        json!({ "code": code }),
    )
    .await
}

/// A new account with two-factor sign-in on. The code that turned it on was from the
/// current step, so the next one to work is from the step after.
async fn turn_on(srv: &TestServer, name: &str) -> (AuthOk, Vec<u8>, Vec<String>) {
    let me = srv.register(name, PASS).await;
    let (secret, _) = setup(srv, &me.token).await;
    away_from_step_edge().await;
    let res = enable(srv, &me.token, &code_for_step(&secret, step_at(now()))).await;
    assert_eq!(res.status(), 200, "enable");
    let body: Value = res.json().await.unwrap();
    let codes = body["recovery_codes"]
        .as_array()
        .expect("recovery codes")
        .iter()
        .map(|c| c.as_str().unwrap().to_owned())
        .collect();
    (me, secret, codes)
}

async fn password_login(srv: &TestServer, name: &str) -> Value {
    let res = srv
        .post_json(
            "/api/v1/auth/login",
            json!({ "username": name, "password": PASS }),
        )
        .await;
    assert_eq!(res.status(), 200, "password step");
    res.json().await.unwrap()
}

async fn second_step(srv: &TestServer, challenge: &str, code: &str) -> reqwest::Response {
    srv.post_json(
        "/api/v1/auth/login/two-factor",
        json!({ "challenge": challenge, "code": code }),
    )
    .await
}

fn challenge_of(login: &Value) -> String {
    assert_eq!(login["two_factor_required"], true, "{login}");
    assert!(
        login.get("token").is_none(),
        "no session before the code: {login}"
    );
    login["challenge"].as_str().expect("challenge").to_owned()
}

/// The next step's code, which the server still takes (a phone's clock may run ahead).
fn next_code(secret: &[u8]) -> String {
    code_for_step(secret, step_at(now()) + 1)
}

#[tokio::test]
async fn turning_it_on_needs_the_password_and_a_working_code() {
    let srv = TestServer::start().await;
    let me = srv.register("tfa_on", PASS).await;
    let before = status(&srv, &me.token).await;
    assert_eq!(before["enabled"], false);
    assert_eq!(before["available"], true);

    let no_password = srv
        .post_json_auth("/api/v1/users/@me/two-factor/setup", &me.token, json!({}))
        .await;
    assert_eq!(no_password.status(), 403);
    let wrong_password = srv
        .post_json_auth(
            "/api/v1/users/@me/two-factor/setup",
            &me.token,
            json!({ "password": "not-it" }),
        )
        .await;
    assert_eq!(wrong_password.status(), 403);

    let (secret, body) = setup(&srv, &me.token).await;
    assert_eq!(secret.len(), 20);
    let url = body["otpauth_url"].as_str().unwrap();
    assert!(url.starts_with("otpauth://totp/"), "{url}");
    assert!(url.contains(body["secret"].as_str().unwrap()), "{url}");
    assert!(url.contains("issuer=Ohiyo"), "{url}");

    away_from_step_edge().await;
    let wrong = enable(&srv, &me.token, &code_for_step(&secret, step_at(now()) + 5)).await;
    assert_eq!(wrong.status(), 403);
    assert_eq!(status(&srv, &me.token).await["enabled"], false);

    let res = enable(&srv, &me.token, &code_for_step(&secret, step_at(now()))).await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    let codes = body["recovery_codes"].as_array().unwrap();
    assert_eq!(codes.len(), 10);
    assert!(codes.iter().all(|c| c.as_str().unwrap().len() == 19));

    let after = status(&srv, &me.token).await;
    assert_eq!(after["enabled"], true);
    assert_eq!(after["recovery_codes_left"], 10);
    let shown = server::auth::two_factor::base32_encode(&secret);
    assert!(
        !after.to_string().contains(&shown),
        "the secret is never shown again"
    );

    let again = srv
        .post_json_auth(
            "/api/v1/users/@me/two-factor/setup",
            &me.token,
            json!({ "password": PASS }),
        )
        .await;
    assert_eq!(again.status(), 409, "already on");
}

#[tokio::test]
async fn signing_in_then_needs_a_code_and_the_password_alone_gets_no_session() {
    let srv = TestServer::start().await;
    let (_me, secret, _codes) = turn_on(&srv, "tfa_login").await;

    let challenge = challenge_of(&password_login(&srv, "tfa_login").await);
    let wrong = second_step(
        &srv,
        &challenge,
        &code_for_step(&secret, step_at(now()) + 5),
    )
    .await;
    assert_eq!(wrong.status(), 403);

    let res = second_step(&srv, &challenge, &next_code(&secret)).await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    let token = body["token"].as_str().expect("a session after the code");
    assert_eq!(srv.get_auth("/api/v1/users/@me", token).await.status(), 200);

    // The challenge was used up.
    let reused = second_step(&srv, &challenge, &next_code(&secret)).await;
    assert_eq!(reused.status(), 401);
}

#[tokio::test]
async fn a_code_works_only_once() {
    let srv = TestServer::start().await;
    let (_me, secret, _codes) = turn_on(&srv, "tfa_once").await;
    away_from_step_edge().await;
    let code = next_code(&secret);

    let first = challenge_of(&password_login(&srv, "tfa_once").await);
    assert_eq!(second_step(&srv, &first, &code).await.status(), 200);

    let second = challenge_of(&password_login(&srv, "tfa_once").await);
    assert_eq!(
        second_step(&srv, &second, &code).await.status(),
        403,
        "the same code again"
    );
}

#[tokio::test]
async fn a_code_from_one_step_ago_is_fine_and_from_two_steps_ago_is_not() {
    let srv = TestServer::start().await;
    let me = srv.register("tfa_skew", PASS).await;
    let (secret, _) = setup(&srv, &me.token).await;
    away_from_step_edge().await;
    let step = step_at(now());
    assert_eq!(
        enable(&srv, &me.token, &code_for_step(&secret, step - 2))
            .await
            .status(),
        403
    );
    assert_eq!(
        enable(&srv, &me.token, &code_for_step(&secret, step - 1))
            .await
            .status(),
        200
    );
}

#[tokio::test]
async fn a_recovery_code_signs_in_once() {
    let srv = TestServer::start().await;
    let (me, _secret, codes) = turn_on(&srv, "tfa_recover").await;
    // Typed in lower case with spaces instead of dashes: still the same code.
    let typed = codes[0].to_lowercase().replace('-', " ");

    let challenge = challenge_of(&password_login(&srv, "tfa_recover").await);
    let res = second_step(&srv, &challenge, &typed).await;
    assert_eq!(res.status(), 200);
    assert_eq!(status(&srv, &me.token).await["recovery_codes_left"], 9);

    let again = challenge_of(&password_login(&srv, "tfa_recover").await);
    assert_eq!(
        second_step(&srv, &again, &codes[0]).await.status(),
        403,
        "used already"
    );
}

#[tokio::test]
async fn wrong_codes_have_to_wait_after_five_a_minute() {
    let srv = TestServer::start().await;
    let (_me, secret, _codes) = turn_on(&srv, "tfa_limit").await;
    let challenge = challenge_of(&password_login(&srv, "tfa_limit").await);
    for _ in 0..4 {
        let wrong = second_step(
            &srv,
            &challenge,
            &code_for_step(&secret, step_at(now()) + 7),
        )
        .await;
        assert_eq!(wrong.status(), 403);
    }
    // Turning it on used one try this minute; this is the sixth.
    let right_but_too_soon = second_step(&srv, &challenge, &next_code(&secret)).await;
    assert_eq!(right_but_too_soon.status(), 429);
}

#[tokio::test]
async fn a_challenge_gives_out_after_ten_wrong_codes() {
    let srv = TestServer::start().await;
    let (me, secret, _codes) = turn_on(&srv, "tfa_lockout").await;
    let challenge = challenge_of(&password_login(&srv, "tfa_lockout").await);
    // Nine wrong codes already, spread over the last few minutes.
    let pool = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    let hash = Sha256::digest(challenge.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let updated = sqlx::query(
        "UPDATE two_factor_challenges SET failures = 9 WHERE token_hash = ? AND user_id = ?",
    )
    .bind(&hash)
    .bind(&me.id)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        updated.rows_affected(),
        1,
        "the challenge is stored by its hash"
    );

    let tenth = second_step(
        &srv,
        &challenge,
        &code_for_step(&secret, step_at(now()) + 7),
    )
    .await;
    assert_eq!(tenth.status(), 403);
    let after = second_step(&srv, &challenge, &next_code(&secret)).await;
    assert_eq!(after.status(), 401, "the challenge is gone; sign in again");
}

#[tokio::test]
async fn turning_it_off_needs_the_password_and_a_code() {
    let srv = TestServer::start().await;
    let (me, secret, codes) = turn_on(&srv, "tfa_off").await;
    let path = "/api/v1/users/@me/two-factor/disable";
    let no_code = srv
        .post_json_auth(path, &me.token, json!({ "password": PASS }))
        .await;
    assert_eq!(no_code.status(), 403, "no code");
    let wrong_password = srv
        .post_json_auth(
            path,
            &me.token,
            json!({ "password": "not-it", "code": next_code(&secret) }),
        )
        .await;
    assert_eq!(wrong_password.status(), 403);
    let both = srv
        .post_json_auth(
            path,
            &me.token,
            json!({ "password": PASS, "code": codes[1] }),
        )
        .await;
    assert_eq!(both.status(), 204);

    let now_off = status(&srv, &me.token).await;
    assert_eq!(now_off["enabled"], false);
    assert_eq!(now_off["recovery_codes_left"], 0);
    let login = password_login(&srv, "tfa_off").await;
    assert!(
        login["token"].is_string(),
        "the password alone signs in again: {login}"
    );
}

#[tokio::test]
async fn changing_the_password_needs_a_code_when_it_is_on() {
    let srv = TestServer::start().await;
    let (me, _secret, codes) = turn_on(&srv, "tfa_pw").await;
    let path = "/api/v1/auth/password";
    let without = srv
        .post_json_auth(
            path,
            &me.token,
            json!({ "current_password": PASS, "new_password": "a-new-password-2" }),
        )
        .await;
    assert_eq!(without.status(), 403);
    assert!(without.text().await.unwrap().contains("code"));
    let with = srv
        .post_json_auth(
            path,
            &me.token,
            json!({
                "current_password": PASS,
                "new_password": "a-new-password-2",
                "two_factor_code": codes[2],
            }),
        )
        .await;
    assert_eq!(with.status(), 200);
}

#[tokio::test]
async fn deleting_the_account_needs_a_code_when_it_is_on() {
    let srv = TestServer::start().await;
    let (me, _secret, codes) = turn_on(&srv, "tfa_delete").await;
    let without = srv
        .delete_json_auth(
            "/api/v1/users/@me",
            &me.token,
            json!({ "password": PASS, "username": "tfa_delete" }),
        )
        .await;
    assert_eq!(without.status(), 403);
    let with = srv
        .delete_json_auth(
            "/api/v1/users/@me",
            &me.token,
            json!({ "password": PASS, "username": "tfa_delete", "two_factor_code": codes[3] }),
        )
        .await;
    assert_eq!(with.status(), 204);
}

#[tokio::test]
async fn new_recovery_codes_replace_the_old_ones() {
    let srv = TestServer::start().await;
    let (me, _secret, codes) = turn_on(&srv, "tfa_regen").await;
    let without_code = srv
        .post_json_auth(
            "/api/v1/users/@me/two-factor/recovery-codes",
            &me.token,
            json!({ "password": PASS }),
        )
        .await;
    assert_eq!(without_code.status(), 403);
    let res = srv
        .post_json_auth(
            "/api/v1/users/@me/two-factor/recovery-codes",
            &me.token,
            json!({ "password": PASS, "code": codes[4] }),
        )
        .await;
    assert_eq!(res.status(), 200);
    let fresh: Vec<String> = res.json::<Value>().await.unwrap()["recovery_codes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(fresh.len(), 10);

    let old = challenge_of(&password_login(&srv, "tfa_regen").await);
    assert_eq!(
        second_step(&srv, &old, &codes[5]).await.status(),
        403,
        "an old code"
    );
    assert_eq!(
        second_step(&srv, &old, &fresh[0]).await.status(),
        200,
        "a new code"
    );
}

#[tokio::test]
async fn without_a_key_it_cannot_be_turned_on() {
    let srv = TestServer::start_with(|state| state.two_factor = None).await;
    let me = srv.register("tfa_nokey", PASS).await;
    assert_eq!(status(&srv, &me.token).await["available"], false);
    let res = srv
        .post_json_auth(
            "/api/v1/users/@me/two-factor/setup",
            &me.token,
            json!({ "password": PASS }),
        )
        .await;
    assert_eq!(res.status(), 503);
}

#[tokio::test]
async fn the_secret_is_stored_encrypted() {
    let srv = TestServer::start().await;
    let (me, secret, _codes) = turn_on(&srv, "tfa_stored").await;
    let pool = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    let blob: Vec<u8> = sqlx::query_scalar("SELECT secret_enc FROM two_factor WHERE user_id = ?")
        .bind(&me.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(
        !blob.windows(secret.len()).any(|w| w == secret.as_slice()),
        "not the raw secret"
    );
    let shown = server::auth::two_factor::base32_encode(&secret);
    assert!(
        !blob.windows(shown.len()).any(|w| w == shown.as_bytes()),
        "not the base32 secret"
    );
    let stored_codes: Vec<String> =
        sqlx::query_scalar("SELECT code_hash FROM two_factor_recovery_codes WHERE user_id = ?")
            .bind(&me.id)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(stored_codes.len(), 10);
    assert!(
        stored_codes.iter().all(|h| h.len() == 64),
        "recovery codes are stored as hashes"
    );
}

#[tokio::test]
async fn other_devices_hear_when_it_is_turned_on_and_off() {
    let srv = TestServer::start().await;
    let me = srv.register("tfa_devices", PASS).await;
    let other = password_login(&srv, "tfa_devices").await;
    let mut other_ws = Gateway::connect(&srv, other["token"].as_str().unwrap()).await;

    let (secret, _) = setup(&srv, &me.token).await;
    away_from_step_edge().await;
    assert_eq!(
        enable(&srv, &me.token, &code_for_step(&secret, step_at(now())))
            .await
            .status(),
        200
    );
    let on = other_ws.wait_for(|e| e["t"] == "TwoFactorUpdate").await;
    assert_eq!(on["d"]["enabled"], true);

    let res = srv
        .post_json_auth(
            "/api/v1/users/@me/two-factor/disable",
            &me.token,
            json!({ "password": PASS, "code": next_code(&secret) }),
        )
        .await;
    assert_eq!(res.status(), 204);
    let off = other_ws.wait_for(|e| e["t"] == "TwoFactorUpdate").await;
    assert_eq!(off["d"]["enabled"], false);
}

#[tokio::test]
async fn twenty_wrong_codes_an_hour_then_no_more_even_on_a_fresh_sign_in() {
    let srv = TestServer::start().await;
    let (me, secret, codes) = turn_on(&srv, "tfa_hourly").await;
    // Nineteen wrong codes over the last hour, as the server recorded them (five a minute keeps
    // them spread out, so they can't be typed here in a test's time).
    let pool = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    for i in 0..19 {
        sqlx::query("INSERT INTO two_factor_failures (user_id, at) VALUES (?, ?)")
            .bind(&me.id)
            .bind(now() - 60 - 170 * i)
            .execute(&pool)
            .await
            .unwrap();
    }
    // The twentieth is just wrong.
    let first = challenge_of(&password_login(&srv, "tfa_hourly").await);
    let twentieth = second_step(&srv, &first, &code_for_step(&secret, step_at(now()) + 7)).await;
    assert_eq!(twentieth.status(), 403);

    // After that nothing is tried for the rest of the hour: not on a fresh sign-in, not the
    // right code, not a recovery code, not a code asked for by turning it off.
    let fresh = challenge_of(&password_login(&srv, "tfa_hourly").await);
    let right = second_step(&srv, &fresh, &next_code(&secret)).await;
    assert_eq!(right.status(), 429);
    let said = right.text().await.unwrap();
    assert!(
        said.contains("Too many codes tried. Try again in a while."),
        "{said}"
    );
    assert_eq!(
        second_step(&srv, &fresh, &codes[0]).await.status(),
        429,
        "recovery code"
    );
    let off = srv
        .post_json_auth(
            "/api/v1/users/@me/two-factor/disable",
            &me.token,
            json!({ "password": PASS, "code": next_code(&secret) }),
        )
        .await;
    assert_eq!(off.status(), 429, "turning it off");

    // An hour on, they no longer count, and the same sign-in goes through.
    sqlx::query("UPDATE two_factor_failures SET at = at - 3600 WHERE user_id = ?")
        .bind(&me.id)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        second_step(&srv, &fresh, &next_code(&secret))
            .await
            .status(),
        200
    );
}

/// What the test server signs sessions with (see `common`), long enough to key a box.
const TEST_JWT: &str = "integration-test-secret-not-for-production";
const OWN_KEY: &str = "a-dedicated-two-factor-key-at-least-32-chars";

#[tokio::test]
async fn setting_its_own_key_later_keeps_codes_working_and_reseals_the_secret() {
    use server::auth::two_factor::SecretBox;
    // The server now has OHIYO_TOTP_KEY; the account turned two-factor on when the secret was
    // sealed under the key derived from JWT_SECRET.
    let srv = TestServer::start_with(|state| {
        state.two_factor = SecretBox::from_values(Some(OWN_KEY), Some(TEST_JWT), false);
    })
    .await;
    let (me, secret, _codes) = turn_on(&srv, "tfa_rekey").await;
    let old_box = SecretBox::from_values(None, Some(TEST_JWT), false).expect("jwt box");
    let pool = sqlx::SqlitePool::connect(srv.db_url()).await.unwrap();
    sqlx::query("UPDATE two_factor SET secret_enc = ? WHERE user_id = ?")
        .bind(old_box.seal(&me.id, &secret))
        .bind(&me.id)
        .execute(&pool)
        .await
        .unwrap();

    let challenge = challenge_of(&password_login(&srv, "tfa_rekey").await);
    let res = second_step(&srv, &challenge, &next_code(&secret)).await;
    assert_eq!(res.status(), 200, "a code still works after the key moved");

    let blob: Vec<u8> = sqlx::query_scalar("SELECT secret_enc FROM two_factor WHERE user_id = ?")
        .bind(&me.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    let own_only = SecretBox::from_values(Some(OWN_KEY), None, false).expect("own box");
    assert_eq!(
        own_only.open(&me.id, &blob).as_deref(),
        Some(secret.as_slice()),
        "the secret was sealed again under the new key"
    );
    let stranger =
        SecretBox::from_values(Some("some-other-key-that-is-32-chars-long"), None, false)
            .expect("other box");
    assert!(
        stranger.open(&me.id, &blob).is_none(),
        "a wrong key still opens nothing"
    );
}

/// A second real HTTP application over the same disposable database, with exactly one
/// connection. Pause one acquisition after the old request's authentication/step-up.
/// Recovery uses the original application's independent pool, so it can commit before
/// we release the old request. No production hooks, sleeps or mocked auth/SQL.
async fn paused_factor_request(
    srv: &TestServer,
    me: &AuthOk,
    action: &str,
    body: Value,
    pause_at: usize,
) -> (
    tokio::task::JoinHandle<reqwest::Response>,
    std::sync::Arc<tokio::sync::Semaphore>,
    tokio::task::JoinHandle<()>,
) {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    let acquisitions = Arc::new(AtomicUsize::new(0));
    let reached = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Semaphore::new(0));
    let (count, signal, wait) = (acquisitions.clone(), reached.clone(), release.clone());
    let pool = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(1)
        .min_connections(1)
        .acquire_timeout(Duration::from_secs(30))
        .before_acquire(move |_, _| {
            let (count, signal, wait) = (count.clone(), signal.clone(), wait.clone());
            Box::pin(async move {
                if count.fetch_add(1, Ordering::SeqCst) + 1 == pause_at {
                    signal.notify_one();
                    wait.acquire().await.unwrap().forget();
                }
                Ok(true)
            })
        })
        .connect(srv.db_url())
        .await
        .unwrap();
    // Pool initialization itself may check out the new connection once. Count only
    // acquisitions made by the HTTP request, not that connectivity check.
    acquisitions.store(0, Ordering::SeqCst);
    let mut state = srv.state.clone();
    state.db = pool;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let serving = tokio::spawn(async move {
        axum::serve(
            listener,
            server::build_app(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let (client, token) = (srv.client.clone(), me.token.clone());
    let url = format!("http://{addr}/api/v1/users/@me/two-factor/{action}");
    let request = tokio::spawn(async move {
        client
            .post(url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .await
            .unwrap()
    });
    tokio::time::timeout(Duration::from_secs(10), reached.notified())
        .await
        .expect("old operation reached the post-step-up pause");
    assert_eq!(acquisitions.load(Ordering::SeqCst), pause_at);
    assert!(!request.is_finished(), "old operation remains suspended");
    (request, release, serving)
}

async fn factor_snapshot(
    srv: &TestServer,
    id: &str,
) -> (
    Option<(String, Option<i64>, i64, i64)>,
    Vec<(String, Option<i64>)>,
) {
    let factor = sqlx::query_as("SELECT hex(secret_enc), enabled_at, last_step, created_at FROM two_factor WHERE user_id = ?")
        .bind(id).fetch_optional(&srv.state.db).await.unwrap();
    let codes = sqlx::query_as("SELECT code_hash, used_at FROM two_factor_recovery_codes WHERE user_id = ? ORDER BY code_hash")
        .bind(id).fetch_all(&srv.state.db).await.unwrap();
    (factor, codes)
}

async fn old_factor_mutation_after_recovery(action: &str) {
    let srv = TestServer::start().await;
    let name = format!("stale_{action}").replace('-', "_");
    let (me, codes, body, pause_at) = match action {
        "setup" => (
            srv.register(&name, PASS).await,
            vec![],
            json!({"password":PASS}),
            3,
        ),
        "enable" => {
            let me = srv.register(&name, PASS).await;
            let (secret, _) = setup(&srv, &me.token).await;
            (
                me,
                vec![],
                json!({"code":code_for_step(&secret, step_at(now()))}),
                4,
            )
        }
        _ => {
            let (me, _, codes) = turn_on(&srv, &name).await;
            let body = json!({"password":PASS,"code":codes[1]});
            (me, codes, body, 7)
        }
    };
    let issued = srv
        .post_json_auth(
            "/api/v1/users/@me/account-recovery",
            &me.token,
            json!({"password":PASS,"two_factor_code":codes.first()}),
        )
        .await;
    assert_eq!(issued.status(), 200);
    let issued: Value = issued.json().await.unwrap();
    // Setup: auth + password read, paused after password verification. Enable: auth,
    // code budget and pending secret read, paused after TOTP verification. Disable/
    // regeneration: auth, password, factor checks, code budget and backup-code consume.
    let (old, release, serving) = paused_factor_request(&srv, &me, action, body, pause_at).await;
    if !codes.is_empty() {
        let used: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM two_factor_recovery_codes WHERE user_id = ? AND used_at IS NOT NULL")
            .bind(&me.id).fetch_one(&srv.state.db).await.unwrap();
        assert_eq!(
            used, 2,
            "issuance and old mutation both passed step-up before recovery"
        );
    }
    let reset = srv
        .post_json(
            "/api/v1/auth/recover",
            json!({"username":name,
        "recovery_code":issued["recovery_code"],"new_password":"after-account-recovery",
        "two_factor_code":codes.get(2)}),
        )
        .await;
    assert_eq!(
        reset.status(),
        204,
        "recovery commits while old operation is held"
    );
    assert_eq!(
        srv.get_auth("/api/v1/users/@me", &me.token).await.status(),
        401
    );
    let before = factor_snapshot(&srv, &me.id).await;
    release.add_permits(1);
    let response = tokio::time::timeout(Duration::from_secs(10), old)
        .await
        .unwrap()
        .unwrap();
    let after = factor_snapshot(&srv, &me.id).await;
    serving.abort();
    assert_eq!(
        after,
        before,
        "stale {action} changed factors after recovery; HTTP {}",
        response.status()
    );
    assert_eq!(
        response.status(),
        401,
        "stale {action} must fail its generation fence"
    );
}

#[tokio::test]
async fn stale_setup_cannot_mutate_after_account_recovery() {
    old_factor_mutation_after_recovery("setup").await;
}

#[tokio::test]
async fn stale_enable_cannot_mutate_after_account_recovery() {
    old_factor_mutation_after_recovery("enable").await;
}

#[tokio::test]
async fn stale_disable_cannot_mutate_after_account_recovery() {
    old_factor_mutation_after_recovery("disable").await;
}

#[tokio::test]
async fn stale_backup_code_rotation_cannot_mutate_after_account_recovery() {
    old_factor_mutation_after_recovery("recovery-codes").await;
}

#[tokio::test]
async fn second_factor_login_checks_address_budget_once_before_touching_the_database() {
    let srv = TestServer::start().await;
    for _ in 0..40 {
        assert_eq!(second_step(&srv, "absent", "123456").await.status(), 401);
    }
    srv.state.db.close().await;
    assert_eq!(
        second_step(&srv, "absent", "123456").await.status(),
        429,
        "an exhausted address must not query even an unavailable database"
    );
}

#[tokio::test]
async fn oversized_second_factor_login_inputs_are_rejected_before_database_access() {
    let srv = TestServer::start().await;
    srv.state.db.close().await;
    assert_eq!(
        second_step(&srv, &"x".repeat(129), "123456").await.status(),
        400
    );
    assert_eq!(
        second_step(&srv, "absent", &"x".repeat(129)).await.status(),
        400
    );
}

#[tokio::test]
async fn an_old_enable_cannot_enable_a_replacement_pending_secret() {
    let srv = TestServer::start().await;
    let me = srv.register("pending_replacement", PASS).await;
    let (secret, _) = setup(&srv, &me.token).await;
    let (old, release, serving) = paused_factor_request(
        &srv,
        &me,
        "enable",
        json!({"code":code_for_step(&secret, step_at(now()))}),
        4,
    )
    .await;
    // Same session generation, but a different pending factor has replaced the one
    // whose code the paused request verified. The generation fence alone cannot help.
    let (replacement, _) = setup(&srv, &me.token).await;
    assert_ne!(secret, replacement);
    let before = factor_snapshot(&srv, &me.id).await;
    release.add_permits(1);
    let res = old.await.unwrap();
    serving.abort();
    assert_eq!(res.status(), 409);
    assert_eq!(factor_snapshot(&srv, &me.id).await, before);
    assert_eq!(
        enable(
            &srv,
            &me.token,
            &code_for_step(&replacement, step_at(now()))
        )
        .await
        .status(),
        200,
        "the replacement's own code still works"
    );
}

async fn old_mutation_cannot_change_replacement_factor(action: &str) {
    let srv = TestServer::start().await;
    let (me, _, codes) = turn_on(&srv, "factor_replacement").await;
    let (old, release, serving) = paused_factor_request(
        &srv,
        &me,
        action,
        json!({"password":PASS,"code":codes[0]}),
        7,
    )
    .await;
    assert_eq!(
        srv.post_json_auth(
            "/api/v1/users/@me/two-factor/disable",
            &me.token,
            json!({"password":PASS,"code":codes[1]})
        )
        .await
        .status(),
        204
    );
    let (replacement, _) = setup(&srv, &me.token).await;
    assert_eq!(
        enable(
            &srv,
            &me.token,
            &code_for_step(&replacement, step_at(now()))
        )
        .await
        .status(),
        200
    );
    let before = factor_snapshot(&srv, &me.id).await;
    release.add_permits(1);
    let res = old.await.unwrap();
    serving.abort();
    assert_eq!(res.status(), 409);
    assert_eq!(
        factor_snapshot(&srv, &me.id).await,
        before,
        "old {action} must not modify a replacement factor or its backup codes"
    );
}

#[tokio::test]
async fn an_old_disable_cannot_remove_a_replacement_factor() {
    old_mutation_cannot_change_replacement_factor("disable").await;
}

#[tokio::test]
async fn an_old_code_rotation_cannot_replace_a_replacement_factors_codes() {
    old_mutation_cannot_change_replacement_factor("recovery-codes").await;
}
