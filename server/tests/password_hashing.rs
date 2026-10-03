//! S-M3: Argon2 is deliberately slow, so password hashing and verification must not run
//! on the async executor, where every other connection on that worker would wait for
//! them. The server and client share one single-threaded runtime here, beside a ticker
//! that wakes every millisecond. Hashing inline would starve the ticker for the whole
//! Argon2 run; on the blocking pool the ticker keeps waking on time.

mod common;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use common::TestServer;
use serde_json::json;

/// Far below one Argon2 run in this build (19 MiB, t=2) and far above a normal wake-up.
const MAX_STALL: Duration = Duration::from_millis(100);

#[tokio::test(flavor = "current_thread")]
async fn register_and_login_do_not_stall_the_runtime() {
    let srv = TestServer::start().await;
    let stop = Arc::new(AtomicBool::new(false));
    let ticker = tokio::spawn({
        let stop = stop.clone();
        async move {
            let mut last = Instant::now();
            let mut worst = Duration::ZERO;
            while !stop.load(Ordering::Relaxed) {
                tokio::time::sleep(Duration::from_millis(1)).await;
                worst = worst.max(last.elapsed());
                last = Instant::now();
            }
            worst
        }
    });

    srv.register("hasher", "password123").await;
    let res = srv
        .post_json(
            "/api/v1/auth/login",
            json!({ "username": "hasher", "password": "password123" }),
        )
        .await;
    assert_eq!(res.status(), 200);

    stop.store(true, Ordering::Relaxed);
    let worst = ticker.await.unwrap();
    assert!(
        worst < MAX_STALL,
        "the runtime stalled for {worst:?} while hashing"
    );
}
