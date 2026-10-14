//! Paid Instant Servers: Stripe Checkout, the signed webhook, cancellation, the customer
//! portal, and what happens to a paid server when it or its owner's account is deleted.
//! The real Stripe client talks to a local stand-in that records every call.

mod common;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use common::{now_unix, TestServer};
use serde_json::{json, Value};
use server::billing::stripe::{sign, StripeBilling};
use server::billing::Billing;
use server::provision::MAX_FREE_INSTANCES;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

const WHSEC: &str = "whsec_integration";
const PRICE: &str = "price_community_monthly";

#[derive(Debug, Clone)]
struct Call {
    method: Method,
    path: String,
    form: HashMap<String, String>,
}

#[derive(Default)]
struct Stand {
    calls: Mutex<Vec<Call>>,
    subscriptions: Mutex<HashMap<String, (i64, Value)>>,
    sessions: Mutex<HashMap<String, Value>>,
    keys: Mutex<HashMap<String, String>>,
    next: AtomicUsize,
    fail_cancel: AtomicBool,
    fail_read: AtomicBool,
    fail_checkout_response: AtomicBool,
    fail_expire: AtomicBool,
}

type Shared = Arc<Stand>;

impl Stand {
    fn record(&self, method: Method, path: String, body: &str) {
        let form = url::form_urlencoded::parse(body.as_bytes())
            .into_owned()
            .collect();
        self.calls.lock().unwrap().push(Call { method, path, form });
    }
    fn calls_to(&self, method: Method, prefix: &str) -> Vec<Call> {
        self.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.method == method && c.path.starts_with(prefix))
            .cloned()
            .collect()
    }
    fn n(&self) -> usize {
        self.next.fetch_add(1, Ordering::SeqCst) + 1
    }
}

async fn customers(State(s): State<Shared>, body: String) -> Json<Value> {
    s.record(Method::POST, "/v1/customers".into(), &body);
    // Idempotent per user, as Stripe is under the same Idempotency-Key.
    let user = url::form_urlencoded::parse(body.as_bytes())
        .find(|(k, _)| k == "metadata[ohiyo_user_id]")
        .map(|(_, v)| v.into_owned())
        .unwrap_or_default();
    Json(json!({ "id": format!("cus_{user}") }))
}

async fn sessions(
    State(s): State<Shared>,
    headers: HeaderMap,
    body: String,
) -> (StatusCode, Json<Value>) {
    s.record(Method::POST, "/v1/checkout/sessions".into(), &body);
    let key = headers.get("idempotency-key").unwrap().to_str().unwrap();
    let mut keys = s.keys.lock().unwrap();
    if let Some(id) = keys.get(key) {
        return (StatusCode::OK, Json(s.sessions.lock().unwrap()[id].clone()));
    }
    let id = format!("cs_{}", s.n());
    let form: HashMap<_, _> = url::form_urlencoded::parse(body.as_bytes())
        .into_owned()
        .collect();
    let session = json!({ "id": id, "status": "open", "url": format!("https://checkout.stripe.test/{id}"), "metadata": {"instance_id": form["metadata[instance_id]"]} });
    keys.insert(key.into(), id.clone());
    s.sessions.lock().unwrap().insert(id, session.clone());
    if s.fail_checkout_response.swap(false, Ordering::SeqCst) {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({"error": {"message": "lost response"}})),
        );
    }
    (StatusCode::OK, Json(session))
}

async fn expire(
    State(s): State<Shared>,
    Path(id): Path<String>,
    body: String,
) -> (StatusCode, Json<Value>) {
    s.record(
        Method::POST,
        format!("/v1/checkout/sessions/{id}/expire"),
        &body,
    );
    if s.fail_expire.load(Ordering::SeqCst) {
        return (StatusCode::BAD_GATEWAY, Json(json!({})));
    }
    s.sessions.lock().unwrap().get_mut(&id).unwrap()["status"] = json!("expired");
    (
        StatusCode::OK,
        Json(json!({ "id": id, "status": "expired" })),
    )
}

async fn get_session(State(s): State<Shared>, Path(id): Path<String>) -> Json<Value> {
    Json(s.sessions.lock().unwrap()[&id].clone())
}

async fn get_subscription(
    State(s): State<Shared>,
    Path(id): Path<String>,
) -> (StatusCode, Json<Value>) {
    if s.fail_read.load(Ordering::SeqCst) {
        return (StatusCode::BAD_GATEWAY, Json(json!({})));
    }
    match s.subscriptions.lock().unwrap().get(&id) {
        Some((_, v)) => (StatusCode::OK, Json(v.clone())),
        None => (StatusCode::NOT_FOUND, Json(json!({}))),
    }
}

async fn portal(State(s): State<Shared>, body: String) -> Json<Value> {
    s.record(Method::POST, "/v1/billing_portal/sessions".into(), &body);
    Json(json!({ "id": "bps_1", "url": "https://billing.stripe.test/session" }))
}

async fn update_sub(State(s): State<Shared>, Path(id): Path<String>, body: String) -> Json<Value> {
    s.record(Method::POST, format!("/v1/subscriptions/{id}"), &body);
    s.subscriptions.lock().unwrap().get_mut(&id).unwrap().1["cancel_at_period_end"] = json!(true);
    Json(json!({ "id": id }))
}

async fn cancel_sub(State(s): State<Shared>, Path(id): Path<String>) -> (StatusCode, Json<Value>) {
    s.record(Method::DELETE, format!("/v1/subscriptions/{id}"), "");
    if s.fail_cancel.load(Ordering::SeqCst) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": { "message": "boom" } })),
        );
    }
    if let Some((_, sub)) = s.subscriptions.lock().unwrap().get_mut(&id) {
        sub["status"] = json!("canceled");
    }
    (
        StatusCode::OK,
        Json(json!({ "id": id, "status": "canceled" })),
    )
}

async fn fake_stripe() -> (String, Shared) {
    let stand: Shared = Arc::default();
    let app = Router::new()
        .route("/v1/customers", post(customers))
        .route("/v1/checkout/sessions", post(sessions))
        .route("/v1/checkout/sessions/{id}", get(get_session))
        .route("/v1/checkout/sessions/{id}/expire", post(expire))
        .route("/v1/billing_portal/sessions", post(portal))
        .route(
            "/v1/subscriptions/{id}",
            post(update_sub).get(get_subscription),
        )
        .route("/v1/subscriptions/{id}", delete(cancel_sub))
        .with_state(stand.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}"), stand)
}

struct StripeServer {
    server: TestServer,
    stripe: Shared,
}

impl std::ops::Deref for StripeServer {
    type Target = TestServer;
    fn deref(&self) -> &TestServer {
        &self.server
    }
}

async fn start_with_stripe() -> (StripeServer, Shared) {
    start_with_cloud(Arc::new(server::provision::fake::FakeProvisioner::default())).await
}

async fn start_with_cloud(
    cloud: Arc<dyn server::provision::MachineProvisioner>,
) -> (StripeServer, Shared) {
    let (base, stand) = fake_stripe().await;
    let srv = TestServer::start_with(|state| {
        state.provisioner = cloud;
        state.billing = Some(Billing {
            provider: Arc::new(StripeBilling::new("sk_test_x", WHSEC, PRICE, base)),
            app_url: "https://app.ohiyo.test".into(),
            price_label: "$8/month".into(),
        });
    })
    .await;
    (
        StripeServer {
            server: srv,
            stripe: stand.clone(),
        },
        stand,
    )
}

async fn create(srv: &TestServer, token: &str, name: &str) -> Value {
    let res = srv
        .post_json_auth("/api/v1/instances", token, json!({ "name": name }))
        .await;
    assert_eq!(res.status(), 200, "create {name}");
    res.json().await.unwrap()
}

async fn instance(srv: &TestServer, token: &str, id: &str) -> Value {
    let res = srv
        .get_auth(&format!("/api/v1/instances/{id}"), token)
        .await;
    assert_eq!(res.status(), 200);
    res.json().await.unwrap()
}

async fn webhook(srv: &StripeServer, event: &Value) -> reqwest::Response {
    advance_stripe(srv, event);
    deliver(srv, event).await
}

fn advance_stripe(srv: &StripeServer, event: &Value) {
    // The stand-in's resource evolves separately from event delivery. A delayed
    // checkout snapshot never rewinds the current subscription resource.
    let obj = &event["data"]["object"];
    let mut subs = srv.stripe.subscriptions.lock().unwrap();
    let at = event["created"].as_i64().unwrap();
    if event["type"]
        .as_str()
        .unwrap()
        .starts_with("customer.subscription.")
    {
        let id = obj["id"].as_str().unwrap();
        if subs.get(id).is_none_or(|(created, _)| at >= *created) {
            let mut current = obj.clone();
            current["items"]["data"][0]["price"] = json!({"id": PRICE});
            current["items"]["data"][0]["quantity"] = json!(1);
            subs.insert(id.into(), (at, current));
        }
    } else if event["type"] == "checkout.session.completed" {
        let sub = obj["subscription"].as_str().unwrap();
        subs.entry(sub.into()).or_insert_with(|| (at, json!({
            "id": sub, "customer": obj["customer"], "metadata": obj["metadata"],
            "status": "active", "cancel_at_period_end": false,
            "items": {"data": [{"price": {"id": PRICE}, "quantity": 1, "current_period_end": 1_900_000_000}]}
        })));
        for session in srv.stripe.sessions.lock().unwrap().values_mut() {
            if session["metadata"]["instance_id"] == obj["metadata"]["instance_id"] {
                session["status"] = json!("complete");
                session["subscription"] = json!(sub);
            }
        }
    }
}

async fn deliver(srv: &TestServer, event: &Value) -> reqwest::Response {
    let body = serde_json::to_vec(event).unwrap();
    srv.client
        .post(srv.url("/api/v1/billing/stripe/webhook"))
        .header("stripe-signature", sign(WHSEC, &body, now_unix()))
        .body(body)
        .send()
        .await
        .unwrap()
}

static EVENT: AtomicUsize = AtomicUsize::new(0);

fn event(kind: &str, created: i64, object: Value) -> Value {
    json!({
        "id": format!("evt_{}", EVENT.fetch_add(1, Ordering::SeqCst)),
        "type": kind,
        "created": created,
        "data": { "object": object }
    })
}

fn checkout_completed(instance_id: &str, customer: &str, sub: &str, created: i64) -> Value {
    event(
        "checkout.session.completed",
        created,
        json!({
            "mode": "subscription", "payment_status": "paid",
            "client_reference_id": instance_id,
            "metadata": { "instance_id": instance_id },
            "customer": customer, "subscription": sub
        }),
    )
}

fn subscription(
    kind: &str,
    instance_id: &str,
    customer: &str,
    sub: &str,
    status: &str,
    cancel: bool,
    created: i64,
) -> Value {
    event(
        kind,
        created,
        json!({
            "id": sub, "customer": customer, "status": status,
            "cancel_at_period_end": cancel,
            "metadata": { "instance_id": instance_id },
            "items": { "data": [ { "current_period_end": 1_900_000_000 } ] }
        }),
    )
}

/// Start a checkout for `id` and complete it with subscription `sub`; returns the customer.
async fn buy(srv: &StripeServer, token: &str, user_id: &str, id: &str, sub: &str) -> String {
    let res = srv
        .post_empty_auth(&format!("/api/v1/instances/{id}/billing/checkout"), token)
        .await;
    assert_eq!(res.status(), 200);
    let customer = format!("cus_{user_id}");
    assert_eq!(
        webhook(srv, &checkout_completed(id, &customer, sub, now_unix()))
            .await
            .status(),
        200
    );
    customer
}

#[tokio::test]
async fn without_stripe_the_paid_plan_is_offered_as_unavailable_and_refused() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "supersecret123").await;
    let avail: Value = srv
        .get_auth("/api/v1/instances/available", &alice.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(avail["available"], true);
    // A test build runs the in-memory fake, and says so: nothing really stays on.
    assert_eq!(avail["provisioner"], "simulated");
    assert_eq!(avail["paid_plan"]["available"], false);
    assert!(avail["paid_plan"]["reason"]
        .as_str()
        .unwrap()
        .contains("Payments"));

    let inst = create(&srv, &alice.token, "No Stripe").await;
    let id = inst["id"].as_str().unwrap();
    let res = srv
        .post_empty_auth(
            &format!("/api/v1/instances/{id}/billing/checkout"),
            &alice.token,
        )
        .await;
    assert_eq!(res.status(), 503);
    assert_eq!(
        srv.post_empty_auth("/api/v1/billing/portal", &alice.token)
            .await
            .status(),
        503
    );
    // Without a webhook secret there is nothing to verify against.
    let res = srv
        .client
        .post(srv.url("/api/v1/billing/stripe/webhook"))
        .body("{}")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
}

#[tokio::test]
async fn the_owner_pays_through_checkout_and_only_the_signed_webhook_turns_the_plan_on() {
    let (srv, stripe) = start_with_stripe().await;
    let alice = srv.register("alice", "supersecret123").await;
    let bob = srv.register("bob", "supersecret123").await;

    let avail: Value = srv
        .get_auth("/api/v1/instances/available", &alice.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(avail["paid_plan"]["available"], true);
    assert_eq!(avail["paid_plan"]["price_label"], "$8/month");

    let inst = create(&srv, &alice.token, "The Roost").await;
    let id = inst["id"].as_str().unwrap();
    assert!(inst["billing"].is_null());

    // Someone else can't start a checkout for it, nor learn that it exists.
    let res = srv
        .post_empty_auth(
            &format!("/api/v1/instances/{id}/billing/checkout"),
            &bob.token,
        )
        .await;
    assert_eq!(res.status(), 404);

    let res = srv
        .post_empty_auth(
            &format!("/api/v1/instances/{id}/billing/checkout"),
            &alice.token,
        )
        .await;
    assert_eq!(res.status(), 200);
    let url = res.json::<Value>().await.unwrap()["checkout_url"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(url.starts_with("https://checkout.stripe.test/cs_"), "{url}");

    let sent = stripe.calls_to(Method::POST, "/v1/checkout/sessions");
    assert_eq!(sent.len(), 1);
    let form = &sent[0].form;
    assert_eq!(form["mode"], "subscription");
    assert_eq!(form["line_items[0][price]"], PRICE);
    assert_eq!(form["customer"], format!("cus_{}", alice.id));
    assert_eq!(form["subscription_data[metadata][instance_id]"], id);
    assert_eq!(form["metadata[owner_id]"], alice.id);
    assert_eq!(
        form["success_url"],
        format!("https://app.ohiyo.test/?instant_billing=success&instance={id}")
    );

    // Coming back from checkout proves nothing: still free, waiting for Stripe.
    let pending = instance(&srv, &alice.token, id).await;
    assert_eq!(pending["tier"], "free");
    assert_eq!(pending["billing"]["status"], "checkout_pending");

    // An unsigned or wrongly signed event is refused and changes nothing.
    let customer = format!("cus_{}", alice.id);
    let completed = checkout_completed(id, &customer, "sub_1", now_unix());
    let body = serde_json::to_vec(&completed).unwrap();
    for header in [
        String::new(),
        sign("whsec_wrong", &body, now_unix()),
        sign(WHSEC, &body, now_unix() - 3600),
    ] {
        let res = srv
            .client
            .post(srv.url("/api/v1/billing/stripe/webhook"))
            .header("stripe-signature", header)
            .body(body.clone())
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 400);
    }
    assert_eq!(instance(&srv, &alice.token, id).await["tier"], "free");

    // A signed event naming someone else's customer doesn't move this server.
    let forged = checkout_completed(id, "cus_mallory", "sub_evil", now_unix());
    assert_eq!(webhook(&srv, &forged).await.status(), 200);
    assert_eq!(instance(&srv, &alice.token, id).await["tier"], "free");

    assert_eq!(webhook(&srv, &completed).await.status(), 200);
    let paid = instance(&srv, &alice.token, id).await;
    assert_eq!(paid["tier"], "paid");
    assert_eq!(paid["billing"]["status"], "active");
    assert!(
        paid["billing"]["stripe_subscription_id"].is_null(),
        "no Stripe ids reach the app"
    );

    // Stripe delivers at least once: the same event again is a no-op.
    assert_eq!(webhook(&srv, &completed).await.status(), 200);

    // Paying twice for one server isn't possible from the app...
    let again = srv
        .post_empty_auth(
            &format!("/api/v1/instances/{id}/billing/checkout"),
            &alice.token,
        )
        .await;
    assert_eq!(again.status(), 409);
    // ...and a second subscription that slips through anyway is cancelled at once.
    let dup = checkout_completed(id, &customer, "sub_2", now_unix());
    assert_eq!(webhook(&srv, &dup).await.status(), 200);
    let cancelled = stripe.calls_to(Method::DELETE, "/v1/subscriptions/");
    assert_eq!(cancelled.len(), 1);
    assert_eq!(cancelled[0].path, "/v1/subscriptions/sub_2");
    assert_eq!(instance(&srv, &alice.token, id).await["tier"], "paid");
}

#[tokio::test]
async fn concurrent_checkout_reuses_the_unfinished_one() {
    let (srv, stripe) = start_with_stripe().await;
    let alice = srv.register("alice", "supersecret123").await;
    let id = create(&srv, &alice.token, "Twice").await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let path = format!("/api/v1/instances/{id}/billing/checkout");
    let (a, b) = tokio::join!(
        srv.post_empty_auth(&path, &alice.token),
        srv.post_empty_auth(&path, &alice.token)
    );
    assert_eq!(a.status(), 200);
    assert_eq!(b.status(), 200);
    assert_eq!(
        a.json::<Value>().await.unwrap(),
        b.json::<Value>().await.unwrap()
    );
    let expired = stripe.calls_to(Method::POST, "/v1/checkout/sessions/");
    assert!(expired.is_empty());
    assert_eq!(stripe.sessions.lock().unwrap().len(), 1);
    // One customer per account, however many checkouts.
    assert_eq!(stripe.calls_to(Method::POST, "/v1/customers").len(), 1);
}

#[tokio::test]
async fn cancelling_keeps_the_plan_to_the_period_end_then_the_server_drops_to_free() {
    let (srv, stripe) = start_with_stripe().await;
    let alice = srv.register("alice", "supersecret123").await;
    let bob = srv.register("bob", "supersecret123").await;
    let id = create(&srv, &alice.token, "Leaving").await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let customer = buy(&srv, &alice.token, &alice.id, &id, "sub_1").await;
    let t0 = now_unix();

    let cancel = format!("/api/v1/instances/{id}/billing/cancel");
    assert_eq!(srv.post_empty_auth(&cancel, &bob.token).await.status(), 404);
    let res = srv.post_empty_auth(&cancel, &alice.token).await;
    assert_eq!(res.status(), 200);
    let body: Value = res.json().await.unwrap();
    assert_eq!(body["tier"], "paid", "paid until the period ends");
    assert_eq!(body["billing"]["cancel_at_period_end"], true);
    let sent = stripe.calls_to(Method::POST, "/v1/subscriptions/sub_1");
    assert_eq!(sent.len(), 1);
    assert_eq!(sent[0].form["cancel_at_period_end"], "true");

    let ev = |status: &str, cancel: bool, at: i64| {
        subscription(
            "customer.subscription.updated",
            &id,
            &customer,
            "sub_1",
            status,
            cancel,
            at,
        )
    };
    assert_eq!(
        webhook(&srv, &ev("active", true, t0 + 10)).await.status(),
        200
    );
    // An older event arriving late doesn't undo the newer one.
    assert_eq!(
        webhook(&srv, &ev("active", false, t0 + 5)).await.status(),
        200
    );
    let state = instance(&srv, &alice.token, &id).await;
    assert_eq!(state["billing"]["cancel_at_period_end"], true);
    assert_eq!(state["billing"]["current_period_end"], 1_900_000_000);

    // A failed renewal is a grace period, not a downgrade.
    assert_eq!(
        webhook(&srv, &ev("past_due", true, t0 + 20)).await.status(),
        200
    );
    assert_eq!(instance(&srv, &alice.token, &id).await["tier"], "paid");

    let ended = subscription(
        "customer.subscription.deleted",
        &id,
        &customer,
        "sub_1",
        "canceled",
        false,
        t0 + 30,
    );
    assert_eq!(webhook(&srv, &ended).await.status(), 200);
    let free = instance(&srv, &alice.token, &id).await;
    assert_eq!(free["tier"], "free");
    assert_eq!(free["billing"]["status"], "canceled");
    assert_eq!(free["status"], "healthy", "the server itself keeps running");

    // Nothing left to cancel; buying again works.
    assert_eq!(
        srv.post_empty_auth(&cancel, &alice.token).await.status(),
        409
    );
    buy(&srv, &alice.token, &alice.id, &id, "sub_3").await;
    assert_eq!(instance(&srv, &alice.token, &id).await["tier"], "paid");
}

#[tokio::test]
async fn paying_wakes_a_sleeping_server_and_frees_a_free_slot() {
    let (srv, _stripe) = start_with_stripe().await;
    let alice = srv.register("alice", "supersecret123").await;
    let mut ids = Vec::new();
    for i in 0..MAX_FREE_INSTANCES {
        ids.push(
            create(&srv, &alice.token, &format!("s{i}")).await["id"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    let over = srv
        .post_json_auth("/api/v1/instances", &alice.token, json!({ "name": "over" }))
        .await;
    assert_eq!(over.status(), 409);

    let id = &ids[0];
    let slept = srv
        .post_empty_auth(&format!("/api/v1/instances/{id}/sleep"), &alice.token)
        .await;
    assert_eq!(slept.status(), 200);
    buy(&srv, &alice.token, &alice.id, id, "sub_1").await;
    let paid = instance(&srv, &alice.token, id).await;
    assert_eq!(paid["tier"], "paid");
    assert_eq!(paid["status"], "healthy", "a paid server is woken");

    create(&srv, &alice.token, "fourth").await;
}

#[tokio::test]
async fn the_portal_opens_for_the_callers_own_billing_account() {
    let (srv, stripe) = start_with_stripe().await;
    let alice = srv.register("alice", "supersecret123").await;
    assert_eq!(
        srv.post_empty_auth("/api/v1/billing/portal", &alice.token)
            .await
            .status(),
        404,
        "no billing account before a first checkout"
    );
    let id = create(&srv, &alice.token, "Portal").await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    buy(&srv, &alice.token, &alice.id, &id, "sub_1").await;
    let res = srv
        .post_empty_auth("/api/v1/billing/portal", &alice.token)
        .await;
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.json::<Value>().await.unwrap()["url"],
        "https://billing.stripe.test/session"
    );
    let sent = stripe.calls_to(Method::POST, "/v1/billing_portal/sessions");
    assert_eq!(sent[0].form["customer"], format!("cus_{}", alice.id));
    assert_eq!(
        sent[0].form["return_url"],
        "https://app.ohiyo.test/?instant_billing=portal"
    );
    assert_eq!(
        srv.post_json("/api/v1/billing/portal", json!({}))
            .await
            .status(),
        401
    );
}

#[tokio::test]
async fn deleting_a_paid_server_cancels_its_plan_first_or_not_at_all() {
    let (srv, stripe) = start_with_stripe().await;
    let alice = srv.register("alice", "supersecret123").await;
    let bob = srv.register("bob", "supersecret123").await;
    let id = create(&srv, &alice.token, "Doomed").await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let customer = buy(&srv, &alice.token, &alice.id, &id, "sub_1").await;
    let path = format!("/api/v1/instances/{id}");

    // Another user's delete reaches neither Stripe nor the server.
    assert_eq!(srv.delete_auth(&path, &bob.token).await.status(), 404);
    assert!(stripe
        .calls_to(Method::DELETE, "/v1/subscriptions/")
        .is_empty());

    stripe.fail_cancel.store(true, Ordering::SeqCst);
    assert_eq!(srv.delete_auth(&path, &alice.token).await.status(), 502);
    assert_eq!(
        instance(&srv, &alice.token, &id).await["tier"],
        "paid",
        "still there, still paid"
    );

    stripe.fail_cancel.store(false, Ordering::SeqCst);
    assert_eq!(srv.delete_auth(&path, &alice.token).await.status(), 204);
    let cancels = stripe.calls_to(Method::DELETE, "/v1/subscriptions/sub_1");
    assert_eq!(cancels.len(), 2);
    assert_eq!(srv.get_auth(&path, &alice.token).await.status(), 404);

    // A late "still active" event for the deleted server cancels again rather than bill.
    let late = subscription(
        "customer.subscription.updated",
        &id,
        &customer,
        "sub_1",
        "active",
        false,
        now_unix() + 60,
    );
    assert_eq!(webhook(&srv, &late).await.status(), 200);
    assert_eq!(
        stripe
            .calls_to(Method::DELETE, "/v1/subscriptions/sub_1")
            .len(),
        3
    );
}

#[tokio::test]
async fn deleting_the_account_cancels_its_paid_plans() {
    let (srv, stripe) = start_with_stripe().await;
    let alice = srv.register("alice", "supersecret123").await;
    let id = create(&srv, &alice.token, "Mine").await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    buy(&srv, &alice.token, &alice.id, &id, "sub_9").await;
    stripe.fail_cancel.store(true, Ordering::SeqCst);
    let failed = srv
        .client
        .delete(srv.url("/api/v1/users/@me"))
        .bearer_auth(&alice.token)
        .json(&json!({"password": "supersecret123", "username": "alice"}))
        .send()
        .await
        .unwrap();
    assert_eq!(failed.status(), 502);
    assert_eq!(instance(&srv, &alice.token, &id).await["tier"], "paid");
    stripe.fail_cancel.store(false, Ordering::SeqCst);
    let res = srv
        .client
        .delete(srv.url("/api/v1/users/@me"))
        .bearer_auth(&alice.token)
        .json(&json!({ "password": "supersecret123", "username": "alice" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    assert_eq!(
        stripe
            .calls_to(Method::DELETE, "/v1/subscriptions/sub_9")
            .len(),
        2
    );
}

#[tokio::test]
async fn an_unpaid_subscription_is_cancelled_before_server_deletion() {
    let (srv, stripe) = start_with_stripe().await;
    let alice = srv.register("alice", "supersecret123").await;
    let id = create(&srv, &alice.token, "Unpaid").await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let customer = buy(&srv, &alice.token, &alice.id, &id, "sub_unpaid").await;
    let ev = subscription(
        "customer.subscription.updated",
        &id,
        &customer,
        "sub_unpaid",
        "unpaid",
        false,
        now_unix() + 1,
    );
    assert_eq!(webhook(&srv, &ev).await.status(), 200);
    assert_eq!(instance(&srv, &alice.token, &id).await["tier"], "free");
    stripe.fail_cancel.store(true, Ordering::SeqCst);
    assert_eq!(
        srv.delete_auth(&format!("/api/v1/instances/{id}"), &alice.token)
            .await
            .status(),
        502
    );
    stripe.fail_cancel.store(false, Ordering::SeqCst);
    assert_eq!(
        srv.delete_auth(&format!("/api/v1/instances/{id}"), &alice.token)
            .await
            .status(),
        204
    );
    assert_eq!(
        stripe
            .calls_to(Method::DELETE, "/v1/subscriptions/sub_unpaid")
            .len(),
        2
    );
}

#[tokio::test]
async fn a_delayed_checkout_cannot_resurrect_a_cancelled_subscription() {
    let (srv, _stripe) = start_with_stripe().await;
    let alice = srv.register("alice", "supersecret123").await;
    let id = create(&srv, &alice.token, "Ordered").await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let customer = buy(&srv, &alice.token, &alice.id, &id, "sub_order").await;
    let at = now_unix();
    let ended = subscription(
        "customer.subscription.deleted",
        &id,
        &customer,
        "sub_order",
        "canceled",
        false,
        at,
    );
    assert_eq!(webhook(&srv, &ended).await.status(), 200);
    assert_eq!(
        webhook(&srv, &checkout_completed(&id, &customer, "sub_order", at))
            .await
            .status(),
        200
    );
    assert_eq!(instance(&srv, &alice.token, &id).await["tier"], "free");

    // A new purchase must not be claimed by a terminal event for the old purchase.
    let path = format!("/api/v1/instances/{id}/billing/checkout");
    assert_eq!(srv.post_empty_auth(&path, &alice.token).await.status(), 200);
    let late = checkout_completed(&id, &customer, "sub_order", at);
    assert_eq!(deliver(&srv, &late).await.status(), 200);
    assert_eq!(
        instance(&srv, &alice.token, &id).await["billing"]["status"],
        "checkout_pending"
    );
    let fresh = checkout_completed(&id, &customer, "sub_fresh", at + 1);
    assert_eq!(webhook(&srv, &fresh).await.status(), 200);
    assert_eq!(instance(&srv, &alice.token, &id).await["tier"], "paid");
}

#[tokio::test]
async fn lost_checkout_response_recovers_and_pending_deletion_fails_closed() {
    let (srv, stripe) = start_with_stripe().await;
    let alice = srv.register("alice", "supersecret123").await;
    let id = create(&srv, &alice.token, "Recovery").await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let path = format!("/api/v1/instances/{id}/billing/checkout");
    stripe.fail_checkout_response.store(true, Ordering::SeqCst);
    assert_eq!(srv.post_empty_auth(&path, &alice.token).await.status(), 502);
    assert_eq!(stripe.sessions.lock().unwrap().len(), 1);
    // A newly built state on the same DB has no in-memory request history.
    let mut restarted = server::build_state(srv.state.db.clone());
    restarted.billing = srv.state.billing.clone();
    restarted.provisioner = srv.state.provisioner.clone();
    server::billing::reconcile(&restarted).await.unwrap();
    assert_eq!(srv.post_empty_auth(&path, &alice.token).await.status(), 200);
    assert_eq!(stripe.sessions.lock().unwrap().len(), 1);

    stripe.fail_expire.store(true, Ordering::SeqCst);
    let delete = format!("/api/v1/instances/{id}");
    assert_eq!(srv.delete_auth(&delete, &alice.token).await.status(), 502);
    assert_eq!(instance(&srv, &alice.token, &id).await["tier"], "free");
    stripe.fail_expire.store(false, Ordering::SeqCst);
    assert_eq!(srv.delete_auth(&delete, &alice.token).await.status(), 204);
    assert_eq!(stripe.sessions.lock().unwrap()["cs_1"]["status"], "expired");

    // Payment completes before its webhook reaches us; deletion must still cancel it.
    let id = create(&srv, &alice.token, "Completed pending").await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        srv.post_empty_auth(
            &format!("/api/v1/instances/{id}/billing/checkout"),
            &alice.token
        )
        .await
        .status(),
        200
    );
    advance_stripe(
        &srv,
        &checkout_completed(&id, &format!("cus_{}", alice.id), "sub_pending", now_unix()),
    );
    assert_eq!(
        srv.delete_auth(&format!("/api/v1/instances/{id}"), &alice.token)
            .await
            .status(),
        204
    );
    assert_eq!(
        stripe.subscriptions.lock().unwrap()["sub_pending"].1["status"],
        "canceled"
    );

    // After a long outage Stripe may have discarded the idempotency key. An
    // ambiguous request needs an operator, not a second payable checkout.
    let id = create(&srv, &alice.token, "Old uncertain checkout").await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let path = format!("/api/v1/instances/{id}/billing/checkout");
    stripe.fail_checkout_response.store(true, Ordering::SeqCst);
    assert_eq!(srv.post_empty_auth(&path, &alice.token).await.status(), 502);
    sqlx::query("UPDATE instance_subscriptions SET checkout_request = json_set(checkout_request, '$.expires_at', ?) WHERE instance_id = ?")
        .bind(now_unix() - 24 * 3600)
        .bind(&id)
        .execute(&srv.state.db)
        .await
        .unwrap();
    assert_eq!(srv.post_empty_auth(&path, &alice.token).await.status(), 409);
    assert_eq!(instance(&srv, &alice.token, &id).await["tier"], "free");
}

#[tokio::test]
async fn missing_webhooks_and_same_second_snapshots_converge_to_stripe_state() {
    let (srv, stripe) = start_with_stripe().await;
    let alice = srv.register("alice", "supersecret123").await;
    let id = create(&srv, &alice.token, "Reconcile").await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let customer = format!("cus_{}", alice.id);
    assert_eq!(
        srv.post_empty_auth(
            &format!("/api/v1/instances/{id}/billing/checkout"),
            &alice.token
        )
        .await
        .status(),
        200
    );
    advance_stripe(
        &srv,
        &checkout_completed(&id, &customer, "sub_current", now_unix()),
    );
    assert_eq!(instance(&srv, &alice.token, &id).await["tier"], "free");
    server::billing::reconcile(&srv.state).await.unwrap();
    assert_eq!(instance(&srv, &alice.token, &id).await["tier"], "paid");
    let at = now_unix();
    let old = subscription(
        "customer.subscription.updated",
        &id,
        &customer,
        "sub_current",
        "active",
        false,
        at,
    );
    for status in [
        "past_due",
        "unpaid",
        "paused",
        "incomplete",
        "trialing",
        "active",
        "canceled",
    ] {
        stripe
            .subscriptions
            .lock()
            .unwrap()
            .get_mut("sub_current")
            .unwrap()
            .1["status"] = json!(status);
        // No new event is delivered: the periodic task must find the change itself.
        server::billing::reconcile(&srv.state).await.unwrap();
        let expected = if ["past_due", "trialing", "active"].contains(&status) {
            "paid"
        } else {
            "free"
        };
        assert_eq!(
            instance(&srv, &alice.token, &id).await["tier"],
            expected,
            "{status}"
        );
        // New event ID, stale snapshot, same timestamp. It must read the current state.
        let mut stale = old.clone();
        stale["id"] = json!(format!("evt_stale_{status}"));
        assert_eq!(deliver(&srv, &stale).await.status(), 200);
        assert_eq!(instance(&srv, &alice.token, &id).await["tier"], expected);
    }
}

#[tokio::test]
async fn webhook_failures_retry_and_concurrent_delivery_is_idempotent() {
    let (srv, stripe) = start_with_stripe().await;
    let alice = srv.register("alice", "supersecret123").await;
    let id = create(&srv, &alice.token, "Retry").await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let path = format!("/api/v1/instances/{id}/billing/checkout");
    assert_eq!(srv.post_empty_auth(&path, &alice.token).await.status(), 200);
    let completed = checkout_completed(&id, &format!("cus_{}", alice.id), "sub_retry", now_unix());
    stripe.fail_read.store(true, Ordering::SeqCst);
    assert_eq!(webhook(&srv, &completed).await.status(), 502);
    assert_eq!(instance(&srv, &alice.token, &id).await["tier"], "free");
    stripe.fail_read.store(false, Ordering::SeqCst);
    let (a, b) = tokio::join!(deliver(&srv, &completed), deliver(&srv, &completed));
    assert_eq!(a.status(), 200);
    assert_eq!(b.status(), 200);
    assert_eq!(instance(&srv, &alice.token, &id).await["tier"], "paid");
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM stripe_events WHERE id = ?")
        .bind(completed["id"].as_str().unwrap())
        .fetch_one(&srv.state.db)
        .await
        .unwrap();
    assert_eq!(count, 1);
    // A different product must never grant entitlement.
    stripe
        .subscriptions
        .lock()
        .unwrap()
        .get_mut("sub_retry")
        .unwrap()
        .1["items"]["data"][0]["price"]["id"] = json!("price_other");
    assert!(server::billing::reconcile(&srv.state).await.is_err());

    // Removing metadata must not make a subscription we already know invisible.
    let mut known = subscription(
        "customer.subscription.updated",
        &id,
        &format!("cus_{}", alice.id),
        "sub_retry",
        "past_due",
        false,
        now_unix(),
    );
    known["data"]["object"]["metadata"] = json!({});
    assert_eq!(webhook(&srv, &known).await.status(), 200);
    assert_eq!(
        instance(&srv, &alice.token, &id).await["billing"]["status"],
        "past_due"
    );

    // A shared Stripe account can sell unrelated products. Those signed events
    // must be acknowledged without applying Ohiyo's price rules to them.
    let unrelated = event(
        "customer.subscription.updated",
        now_unix(),
        json!({"id": "sub_other_product", "customer": "cus_elsewhere", "status": "active", "metadata": {}, "items": {"data": [{}]}}),
    );
    advance_stripe(&srv, &unrelated);
    stripe
        .subscriptions
        .lock()
        .unwrap()
        .get_mut("sub_other_product")
        .unwrap()
        .1["items"]["data"][0]["price"]["id"] = json!("price_other");
    assert_eq!(deliver(&srv, &unrelated).await.status(), 200);
    assert_eq!(instance(&srv, &alice.token, &id).await["tier"], "paid");
}

#[derive(Default)]
struct FailingWake {
    inner: server::provision::fake::FakeProvisioner,
    fail: AtomicBool,
}

#[async_trait::async_trait]
impl server::provision::MachineProvisioner for FailingWake {
    async fn provision(
        &self,
        req: server::provision::ProvisionRequest,
    ) -> Result<server::provision::ProvisionedMachine, server::provision::ProvisionError> {
        self.inner.provision(req).await
    }
    async fn status(
        &self,
        id: &str,
    ) -> Result<server::provision::MachineState, server::provision::ProvisionError> {
        self.inner.status(id).await
    }
    async fn start(&self, id: &str) -> Result<(), server::provision::ProvisionError> {
        if self.fail.load(Ordering::SeqCst) {
            return Err(server::provision::ProvisionError::Upstream(
                "injected wake failure".into(),
            ));
        }
        self.inner.start(id).await
    }
    async fn stop(&self, id: &str) -> Result<(), server::provision::ProvisionError> {
        self.inner.stop(id).await
    }
    async fn destroy(&self, id: &str) -> Result<(), server::provision::ProvisionError> {
        self.inner.destroy(id).await
    }
    async fn destroy_volume(&self, id: &str) -> Result<(), server::provision::ProvisionError> {
        self.inner.destroy_volume(id).await
    }
}

#[tokio::test]
async fn paid_machine_wake_failure_retries_and_external_stops_are_recovered() {
    let cloud = Arc::new(FailingWake::default());
    let (srv, _) = start_with_cloud(cloud.clone()).await;
    let alice = srv.register("alice", "supersecret123").await;
    let inst = create(&srv, &alice.token, "Always on").await;
    let id = inst["id"].as_str().unwrap();
    let sleep = format!("/api/v1/instances/{id}/sleep");
    assert_eq!(
        srv.post_empty_auth(&sleep, &alice.token).await.status(),
        200
    );
    assert_eq!(
        srv.post_empty_auth(
            &format!("/api/v1/instances/{id}/billing/checkout"),
            &alice.token
        )
        .await
        .status(),
        200
    );
    cloud.fail.store(true, Ordering::SeqCst);
    let completed = checkout_completed(id, &format!("cus_{}", alice.id), "sub_wake", now_unix());
    assert_eq!(webhook(&srv, &completed).await.status(), 502);
    assert_eq!(instance(&srv, &alice.token, id).await["status"], "sleeping");
    cloud.fail.store(false, Ordering::SeqCst);
    assert_eq!(deliver(&srv, &completed).await.status(), 200);
    assert_eq!(instance(&srv, &alice.token, id).await["status"], "healthy");
    assert_eq!(
        srv.post_empty_auth(&sleep, &alice.token).await.status(),
        409
    );
    let machine: String =
        sqlx::query_scalar("SELECT machine_id FROM hosted_instances WHERE id = ?")
            .bind(id)
            .fetch_one(&srv.state.db)
            .await
            .unwrap();
    srv.state.provisioner.stop(&machine).await.unwrap();
    server::billing::reconcile(&srv.state).await.unwrap();
    assert_eq!(
        srv.state.provisioner.status(&machine).await.unwrap(),
        server::provision::MachineState::Started
    );
}
