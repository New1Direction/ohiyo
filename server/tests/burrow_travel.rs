//! Real SQLite migrations + public travel capabilities + scripted typed HTTP.
//! No live credentials, network to Duffel, browser, ImOrb or paid operations.
mod common;
use common::TestServer;
use serde_json::{json, Value};
use server::api::burrow::travel::{
    duffel::{Duffel, Http},
    *,
};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;

fn money(n: i64) -> Money {
    Money {
        minor: n,
        currency: "GBP".into(),
    }
}
fn mandate() -> Mandate {
    Mandate {
        maximum: money(85000),
        country_code: "GB".into(),
        city: "London".into(),
        check_in: "2026-11-04".parse().unwrap(),
        check_out: "2026-11-07".parse().unwrap(),
        rooms: 1,
        guests: vec![Guest::Adult],
        require_refundable: true,
        accommodation_ids: vec![],
        area: None,
        bed_type: None,
        substitution_tolerance: SubstitutionTolerance::WithinArea,
        amenity_preferences: vec![],
        minimum_rating: Some(3),
        preferences: vec!["near station".into()],
        spend_capability_id: "prefunded".into(),
    }
}
fn profile() -> TravelerProfile {
    TravelerProfile {
        given_name: "Amelia".into(),
        family_name: "Earhart".into(),
        email: "amelia@example.test".into(),
        phone: "+442080160509".into(),
        born_on: "1980-07-24".parse().unwrap(),
    }
}
fn rate(price: &str) -> Value {
    let deadline = format!(
        "{}T12:00:00Z",
        chrono::Utc::now().date_naive() + chrono::Duration::days(2)
    );
    json!({"id":"rat_a","total_amount":price,"total_currency":"GBP","tax_amount":"82.23","tax_currency":"GBP","fee_amount":"50.94","fee_currency":"GBP","due_at_accommodation_amount":"39.95","due_at_accommodation_currency":"GBP","available_payment_methods":["balance"],"payment_type":"pay_now","loyalty_programme_required":false,"expires_at":deadline,"cancellation_timeline":[{"before":deadline,"refund_amount":price,"currency":"GBP"}],"conditions":[{"description":"Bring photo identification"}]})
}
fn stay(price: &str) -> Value {
    json!({"id":"quo_a","total_amount":price,"total_currency":"GBP","tax_amount":"82.23","tax_currency":"GBP","fee_amount":"50.94","fee_currency":"GBP","due_at_accommodation_amount":"39.95","due_at_accommodation_currency":"GBP","check_in_date":"2026-11-04","check_out_date":"2026-11-07","rooms":1,"guests":[{"type":"adult"}],"accommodation":{"id":"acc_a","name":"Fixture Hotel","rating":3,"location":{"address":{"city_name":"London","country_code":"GB","line_one":"100 Clifton Street"},"geographic_coordinates":{"latitude":51.5071,"longitude":-0.1416}},"rooms":[{"name":"Double Suite","rates":[rate(price)]}]}})
}
fn booking(price: &str) -> Value {
    let mut b = stay(price);
    b["id"] = json!("bok_a");
    b["email"] = json!("amelia@example.test");
    b["status"] = json!("confirmed");
    b["confirmed_at"] = json!(chrono::Utc::now().to_rfc3339());
    b["reference"] = json!("HOTEL123");
    b["guest_types"] = json!([{"type":"adult"}]);
    b["guests"] = json!([{"given_name":"Amelia","family_name":"Earhart"}]);
    b
}
#[derive(Clone)]
struct Fake {
    inner: Arc<Mutex<Wire>>,
    entered: Arc<Notify>,
    release: Arc<Notify>,
}
struct Wire {
    steps: VecDeque<(String, u16, Value)>,
    requests: Vec<(String, Option<Value>, String)>,
    block_create: bool,
    block_quote: bool,
    last_create: Option<Value>,
}
impl Fake {
    fn new() -> Self {
        Self {
            inner: Arc::new(Mutex::new(Wire {
                steps: VecDeque::new(),
                requests: vec![],
                block_create: false,
                block_quote: false,
                last_create: None,
            })),
            entered: Arc::default(),
            release: Arc::default(),
        }
    }
    fn push(&self, path: &str, status: u16, body: Value) {
        self.inner
            .lock()
            .unwrap()
            .steps
            .push_back((path.into(), status, body));
    }
    fn quote(&self, price: &str) {
        self.push("quotes", 201, json!({"data":stay(price)}));
    }
    fn creates(&self) -> usize {
        self.inner
            .lock()
            .unwrap()
            .requests
            .iter()
            .filter(|r| r.0 == "POST bookings")
            .count()
    }
}
#[async_trait::async_trait]
impl Http for Fake {
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        correlation: &str,
    ) -> Result<Evidence> {
        let (status, mut response, block) = {
            let mut w = self.inner.lock().unwrap();
            w.requests
                .push((format!("{method} {path}"), body.clone(), correlation.into()));
            if path == "bookings" {
                w.last_create = body;
            }
            let (expected, status, response) =
                w.steps.pop_front().expect("unexpected provider dispatch");
            assert_eq!(path, expected, "typed Duffel endpoint mismatch");
            let expected_method = if path.starts_with("bookings/") || path.starts_with("bookings?")
            {
                "GET"
            } else {
                "POST"
            };
            assert_eq!(method, expected_method);
            (
                status,
                response,
                (w.block_create && path == "bookings") || (w.block_quote && path == "quotes"),
            )
        };
        if response["data"]["id"] == "bok_a" {
            if let Some(create) = &self.inner.lock().unwrap().last_create {
                response["data"]["metadata"] = create["metadata"].clone();
            }
        }
        if block {
            self.entered.notify_one();
            self.release.notified().await;
        }
        if status == 0 {
            return Err(TravelError::Provider(
                "simulated lost transport acknowledgement".into(),
            ));
        }
        Ok(Evidence {
            status,
            provider_request_id: Some("duffel-request-123".into()),
            correlation_id: Some(correlation.into()),
            body: response,
        })
    }
}
struct Harness {
    server: TestServer,
    scope: Scope,
    ledger: TravelLedger,
    id: String,
    profile_id: String,
}
async fn setup() -> Harness {
    let server = TestServer::start().await;
    let db = &server.state.db;
    for u in ["owner", "other"] {
        sqlx::query("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,'unused',0)").bind(u).bind(u).bind(u).execute(db).await.unwrap();
        sqlx::query("INSERT INTO burrow_tasks(id,user_id,request,created_at,updated_at) VALUES(?,?,'hotel',0,0)").bind(format!("task-{u}")).bind(u).execute(db).await.unwrap();
        sqlx::query("INSERT INTO burrow_computer_workspaces VALUES(?,?,?,0)")
            .bind(format!("ws-{u}"))
            .bind(u)
            .bind(u)
            .execute(db)
            .await
            .unwrap();
        sqlx::query("INSERT INTO burrow_agent_runs(id,task_id,request_version,target,root_goal,goal,max_cost_cents,phase,activity,computer_workspace) VALUES(?,?,0,'pi',?,'hotel',25,'attached','research',?)").bind(format!("run-{u}")).bind(format!("task-{u}")).bind(format!("root-{u}")).bind(format!("ws-{u}")).execute(db).await.unwrap();
    }
    let scope = Scope {
        account_id: "owner".into(),
        workspace_id: "ws-owner".into(),
        task_id: "task-owner".into(),
        root_goal_id: "root-owner".into(),
    };
    let ledger = TravelLedger::new(db.clone());
    ledger
        .record_mandate(&scope, "mandate", 1, &mandate())
        .await
        .unwrap();
    let profile_id = ledger.record_profile("owner", &profile()).await.unwrap();
    let t = ledger
        .begin(
            &scope,
            "mandate",
            1,
            std::slice::from_ref(&profile_id),
            Some(money(75000)),
            "Lowest refundable option near the station; higher rating alternative cost more".into(),
        )
        .await
        .unwrap();
    Harness {
        server,
        scope,
        ledger,
        id: t.id,
        profile_id,
    }
}
fn funding() -> PrefundedDuffelBalance {
    PrefundedDuffelBalance {
        account_id: "owner".into(),
        capability_id: "prefunded".into(),
    }
}
async fn quote(h: &Harness, f: &Fake) {
    f.quote("799.00");
    h.ledger
        .quote(&h.scope, &h.id, &Duffel::new(f.clone()), "rat_a")
        .await
        .unwrap();
}
async fn state(h: &Harness) -> String {
    h.ledger
        .get(&h.scope, &h.id)
        .await
        .unwrap()
        .state
        .as_str()
        .into()
}
async fn held(h: &Harness) -> String {
    sqlx::query_scalar("SELECT state FROM burrow_travel_spend WHERE transaction_id=?")
        .bind(&h.id)
        .fetch_one(&h.server.state.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn bounded_area_bed_and_substitution_policy_fail_closed() {
    use server::api::burrow::travel::duffel::Stays;
    let f = Fake::new();
    f.quote("799.00");
    let mut q = Duffel::new(f.clone()).quote("rat_a").await.unwrap().value;
    let now = server::types::now_unix();
    let mut m = mandate();
    // Asymmetric lat/lon and offsets catch swapped coordinates or an incorrect
    // longitude scale; the radius includes the boundary, not a search tolerance.
    let distance = distance_meters(
        51.5,
        -0.12,
        q.accommodation.latitude,
        q.accommodation.longitude,
    );
    assert!((distance - 1691.0).abs() < 10.0);
    m.area = Some(TravelArea {
        latitude: 51.5,
        longitude: -0.12,
        radius_meters: distance,
    });
    assert!(m.evaluate(&q, now).is_ok());
    m.area.as_mut().unwrap().radius_meters = distance - 0.01;
    assert!(m.evaluate(&q, now).is_err());
    m.area.as_mut().unwrap().radius_meters = distance + 0.01;
    assert!(m.evaluate(&q, now).is_ok());
    for (lat, lon, radius) in [
        (91.0, 0.0, 10.0),
        (0.0, 181.0, 10.0),
        (0.0, 0.0, 0.0),
        (0.0, 0.0, -1.0),
        (f64::NAN, 0.0, 10.0),
        (0.0, 0.0, f64::INFINITY),
    ] {
        let mut bad = m.clone();
        bad.area = Some(TravelArea {
            latitude: lat,
            longitude: lon,
            radius_meters: radius,
        });
        assert!(bad.evaluate(&q, now).is_err());
    }
    let mut bad = q.clone();
    bad.accommodation.longitude = f64::NAN;
    assert!(m.evaluate(&bad, now).is_err());
    // A display name like "Double Suite" is not a bed fact.
    assert_eq!(q.bed_type, None);
    m.bed_type = Some("double".into());
    assert!(m.evaluate(&q, now).is_err());
    q.bed_type = Some("twin".into());
    assert!(m.evaluate(&q, now).is_err());
    q.bed_type = Some("double".into());
    assert!(m.evaluate(&q, now).is_ok());
    m.amenity_preferences = vec!["pool".into()];
    assert!(m.evaluate(&q, now).is_ok());
    m.substitution_tolerance = SubstitutionTolerance::ExactProperty;
    assert!(m.evaluate(&q, now).is_err());
    m.accommodation_ids = vec![q.accommodation.id.clone()];
    assert!(m.evaluate(&q, now).is_ok());
    q.accommodation.id = "another".into();
    assert!(m.evaluate(&q, now).is_err());
    m.substitution_tolerance = SubstitutionTolerance::WithinArea;
    assert!(m.evaluate(&q, now).is_err());
    m.accommodation_ids.clear();
    assert!(m.evaluate(&q, now).is_ok());

    let mut legacy = serde_json::to_value(mandate()).unwrap();
    for key in [
        "area",
        "bed_type",
        "substitution_tolerance",
        "amenity_preferences",
    ] {
        legacy.as_object_mut().unwrap().remove(key);
    }
    let legacy: Mandate = serde_json::from_value(legacy).unwrap();
    assert!(legacy.area.is_none() && legacy.bed_type.is_none());
    assert_eq!(
        legacy.substitution_tolerance,
        SubstitutionTolerance::WithinArea
    );
    assert!(legacy.amenity_preferences.is_empty());
}

#[tokio::test]
async fn duffel_search_uses_stored_area_in_kilometers_not_caller_location() {
    use server::api::burrow::travel::duffel::Stays;
    let f = Fake::new();
    f.push("search", 200, json!({"data":{"results":[]}}));
    let mut m = mandate();
    m.area = Some(TravelArea {
        latitude: 51.5,
        longitude: -0.12,
        radius_meters: 1750.0,
    });
    Duffel::new(f.clone())
        .search(&m, f64::NAN, 180.0)
        .await
        .unwrap();
    let wire = f.inner.lock().unwrap();
    let body = wire.requests[0].1.as_ref().unwrap();
    assert_eq!(
        body["location"],
        json!({"geographic_coordinates":{"latitude":51.5,"longitude":-0.12},"radius":1.75})
    );
}

#[tokio::test]
async fn search_rates_fresh_quote_book_verify_and_result_survive_reopen() {
    let h = setup().await;
    let f = Fake::new();
    let p = Duffel::new(f.clone());
    let mut search = stay("799.00");
    search["id"] = json!("srr_a");
    search["cheapest_rate_total_amount"] = json!("799.00");
    search["cheapest_rate_currency"] = json!("GBP");
    f.push("search", 200, json!({"data":{"results":[search.clone()]}}));
    let results = h
        .ledger
        .search(&h.scope, &h.id, &p, 51.5071, -0.1416)
        .await
        .unwrap();
    assert_eq!(results[0].displayed_total, money(79900));
    // A cheap first rate is compliant; a more expensive second rate is filtered
    // before model ranking. The same quote is rechecked at dispatch.
    search["accommodation"]["rooms"][0]["rates"] = json!([rate("799.00"),{ "id":"unused" }]);
    search["accommodation"]["rooms"][0]["rates"][1] = rate("900.00");
    search["accommodation"]["rooms"][0]["rates"][1]["id"] = json!("rat_expensive");
    f.push(
        "search_results/srr_a/actions/fetch_all_rates",
        200,
        json!({"data":search}),
    );
    let rates = h.ledger.rates(&h.scope, &h.id, &p, "srr_a").await.unwrap();
    assert_eq!(rates.len(), 1);
    assert_eq!(rates[0].rate_id, "rat_a");
    quote(&h, &f).await;
    f.push("bookings", 201, json!({"data":booking("799.00")}));
    f.push("bookings/bok_a", 200, json!({"data":booking("799.00")}));
    let t = h
        .ledger
        .book(&h.scope, &h.id, &p, &funding())
        .await
        .unwrap();
    assert_eq!(t.state, TransactionState::Completed);
    assert_eq!(held(&h).await, "committed");
    let result = t.data.result.unwrap();
    assert_eq!(result.final_quote.total, money(79900));
    assert_eq!(result.research_price, Some(money(75000)));
    assert_eq!(result.research_to_quote_difference_minor, Some(4900));
    assert_eq!(result.scope, h.scope);
    assert_eq!(result.booking.id, "bok_a");
    assert_eq!(result.final_quote.due_at_property, money(3995));
    let request = f.inner.lock().unwrap().last_create.clone().unwrap();
    assert_eq!(
        request["guests"],
        json!([{"given_name":"Amelia","family_name":"Earhart"}])
    );
    assert_eq!(request["phone_number"], "+442080160509");
    assert!(request.get("payment").is_none());
    assert_eq!(request["metadata"]["burrow_transaction_id"], h.id);
    let reopened = sqlx::SqlitePool::connect_with((*h.server.state.db.connect_options()).clone())
        .await
        .unwrap();
    let restored = TravelLedger::new(reopened.clone())
        .get(&h.scope, &h.id)
        .await
        .unwrap();
    assert_eq!(
        restored.data.result.unwrap().booking.reference.as_deref(),
        Some("HOTEL123")
    );
    reopened.close().await;
    assert!(h
        .ledger
        .book(&h.scope, &h.id, &p, &funding())
        .await
        .is_err());
    assert_eq!(f.creates(), 1);
}

#[tokio::test]
async fn mandate_rejects_model_selection_fees_fx_identity_and_refund_violations() {
    let h = setup().await;
    let f = Fake::new();
    let p = Duffel::new(f.clone());
    // 820 + 39.95 > 850, despite the provider debit fitting the budget.
    for bad in [
        {
            let mut q = stay("820.00");
            q["total_amount"] = json!("820.00");
            q
        },
        {
            let mut q = stay("799.00");
            q["total_currency"] = json!("CAD");
            q
        },
        {
            let mut q = stay("799.00");
            q["accommodation"]["location"]["address"]["city_name"] = json!("Paris");
            q
        },
        {
            let mut q = stay("799.00");
            q["accommodation"]["rooms"][0]["rates"][0]["cancellation_timeline"] = json!([]);
            q
        },
        {
            let mut q = stay("799.00");
            q["due_at_accommodation_amount"] = Value::Null;
            q
        },
        {
            let mut q = stay("799.00");
            q["guests"] = json!([{"type":"child","age":9}]);
            q
        },
    ] {
        f.push("quotes", 201, json!({"data":bad}));
        assert!(h
            .ledger
            .quote(&h.scope, &h.id, &p, "rat_bad")
            .await
            .is_err());
        assert!(h
            .ledger
            .book(&h.scope, &h.id, &p, &funding())
            .await
            .is_err());
    }
    assert_eq!(f.creates(), 0);
}

#[tokio::test]
async fn mandate_versions_are_immutable_and_cannot_widen_running_authority() {
    let h = setup().await;
    let mut wider = mandate();
    wider.maximum = money(150000);
    assert!(h
        .ledger
        .record_mandate(&h.scope, "mandate", 1, &wider)
        .await
        .is_err());
    h.ledger
        .record_mandate(&h.scope, "mandate", 2, &wider)
        .await
        .unwrap();
    let f = Fake::new();
    f.quote("900.00");
    assert!(h
        .ledger
        .quote(&h.scope, &h.id, &Duffel::new(f.clone()), "rat_a")
        .await
        .is_err());
    assert_eq!(
        h.ledger.get(&h.scope, &h.id).await.unwrap().mandate_version,
        1
    );
    assert!(h
        .ledger
        .begin(
            &h.scope,
            "mandate",
            2,
            std::slice::from_ref(&h.profile_id),
            None,
            "new ID cannot bypass existing transaction".into()
        )
        .await
        .is_err());
    assert!(
        sqlx::query("UPDATE burrow_travel_mandates SET body='{}' WHERE id='mandate'")
            .execute(&h.server.state.db)
            .await
            .is_err()
    );
}

#[tokio::test]
async fn cross_account_workspace_task_mandate_profile_and_receipts_are_isolated() {
    let h = setup().await;
    let other = Scope {
        account_id: "other".into(),
        workspace_id: "ws-other".into(),
        task_id: "task-other".into(),
        root_goal_id: "root-other".into(),
    };
    assert!(h.ledger.get(&other, &h.id).await.is_err());
    assert!(h.ledger.evidence(&other, &h.id).await.is_err());
    assert!(h.ledger.mandate(&other, "mandate", 1).await.is_err());
    h.ledger
        .record_mandate(&other, "other-mandate", 1, &mandate())
        .await
        .unwrap();
    assert!(h
        .ledger
        .begin(
            &other,
            "other-mandate",
            1,
            std::slice::from_ref(&h.profile_id),
            None,
            "not mine".into()
        )
        .await
        .is_err());
    for altered in [
        Scope {
            workspace_id: "ws-other".into(),
            ..h.scope.clone()
        },
        Scope {
            account_id: "other".into(),
            ..h.scope.clone()
        },
        Scope {
            root_goal_id: "root-other".into(),
            ..h.scope.clone()
        },
    ] {
        assert!(h.ledger.get(&altered, &h.id).await.is_err());
    }
}

#[tokio::test]
async fn expired_quote_refresh_same_changed_allowed_over_budget_and_unavailable() {
    for next in ["799.00", "805.00", "820.00", "unavailable"] {
        let h = setup().await;
        let f = Fake::new();
        let p = Duffel::new(f.clone());
        quote(&h, &f).await;
        // Advance the persisted quote beyond its validity boundary without sleeping.
        sqlx::query("UPDATE burrow_travel_transactions SET body=json_set(body,'$.quote.valid_until',0) WHERE id=?").bind(&h.id).execute(&h.server.state.db).await.unwrap();
        if next == "unavailable" {
            f.push(
                "quotes",
                422,
                json!({"errors":[{"type":"invalid_state_error","code":"rate_unavailable"}]}),
            );
        } else {
            f.quote(next);
        }
        if matches!(next, "799.00" | "805.00") {
            f.push("bookings", 201, json!({"data":booking(next)}));
            f.push("bookings/bok_a", 200, json!({"data":booking(next)}));
            let t = h
                .ledger
                .book(&h.scope, &h.id, &p, &funding())
                .await
                .unwrap();
            assert_eq!(t.state, TransactionState::Completed);
            assert_eq!(
                t.data.result.unwrap().final_quote.total,
                if next == "805.00" {
                    money(80500)
                } else {
                    money(79900)
                }
            );
        } else {
            assert!(h
                .ledger
                .book(&h.scope, &h.id, &p, &funding())
                .await
                .is_err());
            assert_eq!(f.creates(), 0);
        }
    }
}

#[tokio::test]
async fn explicit_rejection_releases_spend_but_requires_explicit_requote_to_retry() {
    for status in [422, 503] {
        let h = setup().await;
        let f = Fake::new();
        let p = Duffel::new(f.clone());
        quote(&h, &f).await;
        f.push("bookings",status,json!({"errors":[{"type":if status==503 {"api_error"}else{"fraud_error"},"code":if status==503 {"temporarily_unavailable"}else{"high_fraud_risk"}}]}));
        assert_eq!(
            h.ledger
                .book(&h.scope, &h.id, &p, &funding())
                .await
                .unwrap()
                .state,
            TransactionState::BookingFailed
        );
        assert_eq!(held(&h).await, "released");
        assert!(h
            .ledger
            .book(&h.scope, &h.id, &p, &funding())
            .await
            .is_err());
        assert_eq!(f.creates(), 1);
        if status == 503 {
            // Duffel's explicit non-booked 503 is proof permitting the explicit
            // failed -> fresh quote -> dispatch transition, unlike list absence.
            quote(&h, &f).await;
            f.push("bookings", 201, json!({"data":booking("799.00")}));
            f.push("bookings/bok_a", 200, json!({"data":booking("799.00")}));
            assert_eq!(
                h.ledger
                    .book(&h.scope, &h.id, &p, &funding())
                    .await
                    .unwrap()
                    .state,
                TransactionState::Completed
            );
            assert_eq!(f.creates(), 2);
        } else {
            assert!(h.ledger.quote(&h.scope, &h.id, &p, "rat_a").await.is_err());
            assert!(h
                .ledger
                .record_selection(&h.scope, &h.id, "bypass attempt".into(), None)
                .await
                .is_err());
        }
    }
}

#[tokio::test]
async fn possible_write_failures_never_release_or_blindly_redispatch() {
    for status in [0, 202, 500, 502, 504, 408, 200] {
        let h = setup().await;
        let f = Fake::new();
        let p = Duffel::new(f.clone());
        quote(&h, &f).await;
        f.push(
            "bookings",
            status,
            json!({"errors":[{"type":"api_error"}],"data":{}}),
        );
        assert_eq!(
            h.ledger
                .book(&h.scope, &h.id, &p, &funding())
                .await
                .unwrap()
                .state,
            TransactionState::BookingUncertain
        );
        assert_eq!(held(&h).await, "reserved");
        assert!(h
            .ledger
            .book(&h.scope, &h.id, &p, &funding())
            .await
            .is_err());
        assert!(h.ledger.quote(&h.scope, &h.id, &p, "rat_a").await.is_err());
        assert_eq!(f.creates(), 1);
        h.ledger.stop(&h.scope, &h.id).await.unwrap();
        assert_eq!(state(&h).await, "booking_uncertain");
    }
}

#[tokio::test]
async fn crash_after_dispatch_fence_stop_and_concurrent_replay_reconcile_without_duplicate() {
    let h = setup().await;
    let f = Fake::new();
    let p = Arc::new(Duffel::new(f.clone()));
    quote(&h, &f).await;
    f.inner.lock().unwrap().block_create = true;
    f.push("bookings", 201, json!({"data":booking("799.00")}));
    let (l, s, id, provider) = (h.ledger.clone(), h.scope.clone(), h.id.clone(), p.clone());
    let operation =
        tokio::spawn(async move { l.book(&s, &id, provider.as_ref(), &funding()).await });
    f.entered.notified().await;
    assert_eq!(state(&h).await, "booking_dispatched");
    assert_eq!(held(&h).await, "reserved");
    assert!(h
        .ledger
        .book(&h.scope, &h.id, p.as_ref(), &funding())
        .await
        .is_err());
    h.ledger.stop(&h.scope, &h.id).await.unwrap();
    operation.abort();
    let _ = operation.await;
    let mut b = booking("799.00");
    b["metadata"] = f.inner.lock().unwrap().last_create.as_ref().unwrap()["metadata"].clone();
    f.push(
        "bookings?limit=200",
        200,
        json!({"data":[b],"meta":{"after":null}}),
    );
    let reopened = sqlx::SqlitePool::connect_with((*h.server.state.db.connect_options()).clone())
        .await
        .unwrap();
    let restored = TravelLedger::new(reopened.clone());
    let t = restored
        .reconcile(&h.scope, &h.id, p.as_ref())
        .await
        .unwrap();
    assert_eq!(t.state, TransactionState::Completed);
    assert!(t.stopped);
    assert_eq!(f.creates(), 1);
    reopened.close().await;
}

#[tokio::test]
async fn empty_list_ambiguous_fingerprint_and_reconciliation_deadline_fail_closed() {
    for scenario in ["empty", "ambiguous", "deadline"] {
        let h = setup().await;
        let f = Fake::new();
        let p = Duffel::new(f.clone());
        quote(&h, &f).await;
        f.push("bookings", 500, json!({"errors":[{"type":"api_error"}]}));
        h.ledger
            .book(&h.scope, &h.id, &p, &funding())
            .await
            .unwrap();
        if scenario == "deadline" {
            sqlx::query("UPDATE burrow_travel_transactions SET reconcile_started_at=?,state='reconciling' WHERE id=?").bind(server::types::now_unix()-901).bind(&h.id).execute(&h.server.state.db).await.unwrap();
        } else {
            f.push("bookings?limit=200",200,json!({"data":if scenario=="empty" {json!([])}else{json!([booking("799.00"),booking("799.00")])},"meta":{"after":null}}));
        }
        let t = h.ledger.reconcile(&h.scope, &h.id, &p).await.unwrap();
        assert_eq!(
            t.state.as_str(),
            if scenario == "empty" {
                "booking_uncertain"
            } else {
                "unresolved_needs_attention"
            }
        );
        assert_eq!(held(&h).await, "reserved");
        assert!(h
            .ledger
            .book(&h.scope, &h.id, &p, &funding())
            .await
            .is_err());
        assert_eq!(f.creates(), 1);
        if scenario == "empty" {
            assert!(h.ledger.reconcile(&h.scope, &h.id, &p).await.is_err());
        }
        if scenario == "ambiguous" {
            let evidence = h.ledger.evidence(&h.scope, &h.id).await.unwrap();
            assert!(!serde_json::to_string(&evidence)
                .unwrap()
                .contains("HOTEL123"));
        }
    }
}

#[tokio::test]
async fn stop_before_dispatch_or_existing_pi_stop_prevents_research_and_booking() {
    for pi_stop in [false, true] {
        let h = setup().await;
        let f = Fake::new();
        let p = Duffel::new(f.clone());
        if pi_stop {
            sqlx::query("INSERT INTO burrow_agent_commands(id,run_id,action,message,phase) VALUES('stop-id','run-owner','stop','','queued')").execute(&h.server.state.db).await.unwrap();
        } else {
            h.ledger.stop(&h.scope, &h.id).await.unwrap();
        }
        assert!(h.ledger.search(&h.scope, &h.id, &p, 51., 0.).await.is_err());
        assert!(h.ledger.quote(&h.scope, &h.id, &p, "rat_a").await.is_err());
        assert!(h
            .ledger
            .book(&h.scope, &h.id, &p, &funding())
            .await
            .is_err());
        assert!(f.inner.lock().unwrap().requests.is_empty());
    }
}

#[tokio::test]
async fn unsupported_payment_missing_profile_and_account_enablement_fail_closed() {
    let h = setup().await;
    let f = Fake::new();
    let p = Duffel::new(f.clone());
    let mut card = stay("799.00");
    card["accommodation"]["rooms"][0]["rates"][0]["available_payment_methods"] = json!(["card"]);
    f.push("quotes", 201, json!({"data":card}));
    assert!(h.ledger.quote(&h.scope, &h.id, &p, "rat_a").await.is_err());
    quote(&h, &f).await;
    let wrong = PrefundedDuffelBalance {
        account_id: "other".into(),
        capability_id: "prefunded".into(),
    };
    assert!(h.ledger.book(&h.scope, &h.id, &p, &wrong).await.is_err());
    assert_eq!(f.creates(), 0);
    let mut missing = profile();
    missing.phone = "".into();
    assert!(h.ledger.record_profile("owner", &missing).await.is_err());
    f.push(
        "search",
        403,
        json!({"errors":[{"type":"invalid_request_error","code":"stays_not_enabled"}]}),
    );
    let error = h
        .ledger
        .search(&h.scope, &h.id, &p, 51., 0.)
        .await
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("403")
            && error.contains("stays_not_enabled")
            && error.contains("duffel-request-123")
    );
    let evidence = h.ledger.evidence(&h.scope, &h.id).await.unwrap();
    assert_eq!(
        evidence.last().unwrap().body["evidence"]["body"]["errors"][0]["code"],
        "stays_not_enabled"
    );
}

#[test]
fn exact_money_rejects_unsupported_precision_and_currency() {
    assert_eq!(Money::parse("12.34", "GBP").unwrap(), money(1234));
    assert_eq!(Money::parse("7", "JPY").unwrap().minor, 7);
    assert_eq!(Money::parse("1.234", "KWD").unwrap().minor, 1234);
    for (n, c) in [
        ("1.001", "GBP"),
        ("NaN", "GBP"),
        ("-1", "GBP"),
        ("1e2", "GBP"),
        ("1.00", "ZZZ"),
        ("9223372036854775808", "JPY"),
    ] {
        assert!(Money::parse(n, c).is_err());
    }
}

#[tokio::test]
async fn pre_dispatch_restart_is_safe_and_a_superseded_quote_cannot_overwrite_selection() {
    let h = setup().await;
    let f = Fake::new();
    let p = Arc::new(Duffel::new(f.clone()));
    f.inner.lock().unwrap().block_quote = true;
    f.quote("799.00");
    let (l, s, id, provider) = (h.ledger.clone(), h.scope.clone(), h.id.clone(), p.clone());
    let old = tokio::spawn(async move { l.quote(&s, &id, provider.as_ref(), "rat_a").await });
    f.entered.notified().await;
    assert!(h
        .ledger
        .book(&h.scope, &h.id, p.as_ref(), &funding())
        .await
        .is_err());
    f.inner.lock().unwrap().block_quote = false;
    h.ledger
        .record_selection(
            &h.scope,
            &h.id,
            "New preferred refundable option".into(),
            Some(money(74000)),
        )
        .await
        .unwrap();
    f.quote("805.00");
    h.ledger
        .quote(&h.scope, &h.id, p.as_ref(), "rat_a")
        .await
        .unwrap();
    f.release.notify_one();
    assert!(old.await.unwrap().is_err());
    assert_eq!(
        h.ledger
            .get(&h.scope, &h.id)
            .await
            .unwrap()
            .data
            .quote
            .unwrap()
            .total,
        money(80500)
    );
    let reopened = sqlx::SqlitePool::connect_with((*h.server.state.db.connect_options()).clone())
        .await
        .unwrap();
    f.push("bookings", 201, json!({"data":booking("805.00")}));
    f.push("bookings/bok_a", 200, json!({"data":booking("805.00")}));
    let t = TravelLedger::new(reopened.clone())
        .book(&h.scope, &h.id, p.as_ref(), &funding())
        .await
        .unwrap();
    assert_eq!(t.state, TransactionState::Completed);
    assert_eq!(
        t.data.result.unwrap().research_to_quote_difference_minor,
        Some(6500)
    );
    assert_eq!(f.creates(), 1);
    reopened.close().await;
}

#[tokio::test]
async fn stop_during_quote_discards_response_without_booking() {
    let h = setup().await;
    let f = Fake::new();
    f.inner.lock().unwrap().block_quote = true;
    f.quote("799.00");
    let (l, s, id, wire) = (h.ledger.clone(), h.scope.clone(), h.id.clone(), f.clone());
    let operation =
        tokio::spawn(async move { l.quote(&s, &id, &Duffel::new(wire), "rat_a").await });
    f.entered.notified().await;
    h.ledger.stop(&h.scope, &h.id).await.unwrap();
    f.release.notify_one();
    assert!(operation.await.unwrap().is_err());
    assert_eq!(state(&h).await, "stopped");
    assert_eq!(f.creates(), 0);
}

#[tokio::test]
async fn paginated_reconciliation_requires_complete_unambiguous_evidence() {
    for second_page_fails in [false, true] {
        let h = setup().await;
        let f = Fake::new();
        let p = Duffel::new(f.clone());
        quote(&h, &f).await;
        f.push("bookings", 0, json!({}));
        h.ledger
            .book(&h.scope, &h.id, &p, &funding())
            .await
            .unwrap();
        let mut b = booking("799.00");
        b["metadata"] = f.inner.lock().unwrap().last_create.as_ref().unwrap()["metadata"].clone();
        f.push(
            "bookings?limit=200",
            200,
            json!({"data":[b],"meta":{"after":"next/page"}}),
        );
        f.push(
            "bookings?limit=200&after=next%2Fpage",
            if second_page_fails { 500 } else { 200 },
            if second_page_fails {
                json!({"errors":[{"type":"api_error"}]})
            } else {
                json!({"data":[],"meta":{"after":null}})
            },
        );
        let t = h.ledger.reconcile(&h.scope, &h.id, &p).await.unwrap();
        assert_eq!(
            t.state,
            if second_page_fails {
                TransactionState::BookingUncertain
            } else {
                TransactionState::Completed
            }
        );
        assert_eq!(
            held(&h).await,
            if second_page_fails {
                "reserved"
            } else {
                "committed"
            }
        );
        assert_eq!(f.creates(), 1);
    }
}

#[tokio::test]
async fn six_reconciliation_attempts_are_bounded_and_operator_can_resume_reads_only() {
    let h = setup().await;
    let f = Fake::new();
    let p = Duffel::new(f.clone());
    quote(&h, &f).await;
    f.push("bookings", 500, json!({"errors":[{"type":"api_error"}]}));
    h.ledger
        .book(&h.scope, &h.id, &p, &funding())
        .await
        .unwrap();
    for attempt in 1..=6 {
        sqlx::query("UPDATE burrow_travel_transactions SET reconcile_next_at=0 WHERE id=?")
            .bind(&h.id)
            .execute(&h.server.state.db)
            .await
            .unwrap();
        f.push(
            "bookings?limit=200",
            200,
            json!({"data":[],"meta":{"after":null}}),
        );
        let t = h.ledger.reconcile(&h.scope, &h.id, &p).await.unwrap();
        assert_eq!(t.reconcile_attempts, attempt);
        assert_eq!(
            t.state,
            if attempt == 6 {
                TransactionState::UnresolvedNeedsAttention
            } else {
                TransactionState::BookingUncertain
            }
        );
    }
    h.ledger.stop(&h.scope, &h.id).await.unwrap();
    // A genuinely late confirmation can be recognized in a new read-only window,
    // without widening the create fence or releasing the reserved spend.
    sqlx::query(
        "UPDATE burrow_travel_transactions SET body=json_set(body,'$.dispatched_at',?) WHERE id=?",
    )
    .bind(server::types::now_unix() - 3600)
    .bind(&h.id)
    .execute(&h.server.state.db)
    .await
    .unwrap();
    h.ledger
        .resume_reconciliation(
            &h.scope,
            &h.id,
            "Support located an outcome; retry read-only lookup",
        )
        .await
        .unwrap();
    assert!(h
        .ledger
        .book(&h.scope, &h.id, &p, &funding())
        .await
        .is_err());
    let mut b = booking("799.00");
    b["metadata"] = f.inner.lock().unwrap().last_create.as_ref().unwrap()["metadata"].clone();
    f.push(
        "bookings?limit=200",
        200,
        json!({"data":[b],"meta":{"after":null}}),
    );
    let t = h.ledger.reconcile(&h.scope, &h.id, &p).await.unwrap();
    assert_eq!(t.state, TransactionState::Completed);
    assert!(t.stopped);
    assert_eq!(f.creates(), 1);
}

#[tokio::test]
async fn confirmed_booking_with_changed_price_terms_or_guest_is_not_verified_complete() {
    for change in ["price", "cancellation", "guest"] {
        let h = setup().await;
        let f = Fake::new();
        let p = Duffel::new(f.clone());
        quote(&h, &f).await;
        let mut b = booking(if change == "price" {
            "810.00"
        } else {
            "799.00"
        });
        if change == "cancellation" {
            b["accommodation"]["rooms"][0]["rates"][0]["cancellation_timeline"] = json!([]);
        }
        if change == "guest" {
            b["guests"][0]["family_name"] = json!("Wrong Guest");
        }
        f.push("bookings", 201, json!({"data":b.clone()}));
        f.push("bookings/bok_a", 200, json!({"data":b}));
        let t = h
            .ledger
            .book(&h.scope, &h.id, &p, &funding())
            .await
            .unwrap();
        assert_ne!(t.state, TransactionState::Completed);
        assert!(t.data.result.is_none());
        assert_eq!(held(&h).await, "reserved");
        assert_eq!(f.creates(), 1);
    }
}
