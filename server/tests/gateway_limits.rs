//! S-M11: gateway sockets are bounded. The transport refuses any inbound message or frame
//! over 256 KiB, one user holds at most 20 live sockets (the 21st is closed at once with
//! 1008 and gets no Ready), and logging out everywhere closes the user's live sockets.

mod common;

use common::{ws::Gateway, TestServer};

async fn ready(srv: &TestServer, token: &str) -> Gateway {
    let mut gw = Gateway::connect(srv, token).await;
    gw.wait_for(|e| e["t"] == "Ready").await;
    gw
}

#[tokio::test]
async fn a_frame_over_256_kib_closes_the_socket() {
    let srv = TestServer::start().await;
    let alice = srv.register("bigframe", "password123").await;
    let mut gw = ready(&srv, &alice.token).await;

    gw.send_oversized(256 * 1024 + 1).await;

    gw.wait_closed().await;
}

#[tokio::test]
async fn a_users_21st_socket_is_refused() {
    let srv = TestServer::start().await;
    let alice = srv.register("manytabs", "password123").await;
    let mut open = Vec::new();
    for _ in 0..20 {
        open.push(ready(&srv, &alice.token).await);
    }

    let mut extra = Gateway::connect(&srv, &alice.token).await;
    let (code, events) = extra.wait_closed().await;
    assert_eq!(code, Some(1008), "closed as a policy violation");
    assert!(
        events.is_empty(),
        "no Ready or other event first: {events:?}"
    );
    assert_eq!(srv.state.sessions.read().unwrap()[&alice.id].len(), 20);

    // The cap is per user.
    let bob = srv.register("onetab", "password123").await;
    ready(&srv, &bob.token).await;
}

#[tokio::test]
async fn logout_everywhere_closes_the_users_live_sockets() {
    let srv = TestServer::start().await;
    let alice = srv.register("logoutall", "password123").await;
    let bob = srv.register("staysonline", "password123").await;
    let mut phone = ready(&srv, &alice.token).await;
    let mut laptop = ready(&srv, &alice.token).await;
    let _bobs_socket = ready(&srv, &bob.token).await;

    let res = srv
        .post_empty_auth("/api/v1/auth/logout-everywhere", &alice.token)
        .await;
    assert_eq!(res.status(), 204);

    phone.wait_closed().await;
    laptop.wait_closed().await;
    assert!(
        srv.state.sessions.read().unwrap().contains_key(&bob.id),
        "other users' sockets stay"
    );
}
