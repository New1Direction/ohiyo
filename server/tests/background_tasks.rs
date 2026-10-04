//! S-H8: content-free push dispatch runs on its own task, so the sweeps (disappearing
//! messages, the dead-man's switch, link-code GC) never wait on a slow push provider.
//!
//! Every test in this binary turns push dispatch on, so the flag can't leak elsewhere.

mod common;

use std::time::{Duration, Instant};

use common::TestServer;
use sqlx::SqlitePool;

/// Fast enough that a test sees several passes, slow enough not to spin.
const PERIOD: Duration = Duration::from_millis(20);

/// Upper bound on any wait, so a missing pass fails the test instead of hanging it.
const WAIT_LIMIT: Duration = Duration::from_secs(10);

async fn db(srv: &TestServer) -> SqlitePool {
    SqlitePool::connect(srv.db_url()).await.unwrap()
}

/// Turn dispatch on with no provider configured, so a dispatch attempt is recorded as a
/// retry without contacting any provider.
fn enable_dispatch_without_providers() {
    std::env::set_var("OHIYO_PUSH_DISPATCH_ENABLED", "1");
    std::env::remove_var("OHIYO_FCM_SERVICE_ACCOUNT_JSON");
    std::env::remove_var("OHIYO_FCM_SERVICE_ACCOUNT_FILE");
}

/// Queue one content-free delivery to an FCM device of `user_id`.
async fn queue_delivery(pool: &SqlitePool, user_id: &str) {
    sqlx::query(
        "INSERT INTO push_devices (id, user_id, platform, endpoint, enabled, created_at, updated_at)
         VALUES ('dev-1', ?, 'fcm', 'fcm-token-1', 1, 0, 0)",
    )
    .bind(user_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO push_deliveries (id, user_id, device_id, kind, status, attempts, created_at)
         VALUES ('job-1', ?, 'dev-1', 'message', 'queued', 0, 0)",
    )
    .bind(user_id)
    .execute(pool)
    .await
    .unwrap();
}

async fn delivery_attempts(pool: &SqlitePool) -> i64 {
    sqlx::query_scalar("SELECT attempts FROM push_deliveries WHERE id = 'job-1'")
        .fetch_one(pool)
        .await
        .unwrap()
}

/// Add an expired device-link code and wait until a sweep pass deletes it.
async fn wait_for_a_sweep(pool: &SqlitePool, user_id: &str, code: &str) {
    sqlx::query("INSERT INTO device_link_tokens (code, user_id, expires_at) VALUES (?, ?, 0)")
        .bind(code)
        .bind(user_id)
        .execute(pool)
        .await
        .unwrap();
    let deadline = Instant::now() + WAIT_LIMIT;
    loop {
        let left: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM device_link_tokens WHERE code = ?")
                .bind(code)
                .fetch_one(pool)
                .await
                .unwrap();
        if left == 0 {
            return;
        }
        assert!(Instant::now() < deadline, "no sweep pass removed {code}");
        tokio::time::sleep(PERIOD).await;
    }
}

#[tokio::test]
async fn the_sweeper_never_runs_push_dispatch() {
    enable_dispatch_without_providers();
    let srv = TestServer::start().await;
    let alice = srv.register("sweeperonly", "supersecret123").await;
    let pool = db(&srv).await;
    queue_delivery(&pool, &alice.id).await;

    let sweeper = server::spawn_sweeper(srv.state.clone(), PERIOD);
    // The second code is added only after a pass removed the first, so at least one
    // whole pass ran in between.
    wait_for_a_sweep(&pool, &alice.id, "FIRSTCODE").await;
    wait_for_a_sweep(&pool, &alice.id, "SECONDCODE").await;
    sweeper.abort();

    assert_eq!(
        delivery_attempts(&pool).await,
        0,
        "a sweep pass must not wait on push dispatch"
    );
}

#[tokio::test]
async fn the_push_dispatcher_delivers_on_its_own_task() {
    enable_dispatch_without_providers();
    let srv = TestServer::start().await;
    let alice = srv.register("dispatcheronly", "supersecret123").await;
    let pool = db(&srv).await;
    queue_delivery(&pool, &alice.id).await;

    let dispatcher = server::spawn_push_dispatcher(srv.state.clone(), PERIOD);
    let deadline = Instant::now() + WAIT_LIMIT;
    while delivery_attempts(&pool).await == 0 {
        assert!(
            Instant::now() < deadline,
            "the dispatcher never attempted the delivery"
        );
        tokio::time::sleep(PERIOD).await;
    }
    dispatcher.abort();
}
