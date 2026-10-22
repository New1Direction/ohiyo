//! Authenticated HTTP workflow, real SQLite ledger and offline provider fixtures.
//! The final test also crosses the real Node/Pi Durable bridge and crashes/reopens it.
mod common;
use common::TestServer;
use serde_json::{json, Value};
use server::api::burrow::agent::{self, Kikka, Pi};
use std::{path::PathBuf, time::Duration};

const WORKER: &str = "fixture-only-worker-token-not-a-secret";
struct Trip {
    s: TestServer,
    owner: String,
    other: String,
    id: String,
    workspace: String,
    root: String,
}
async fn ok(r: reqwest::Response) -> Value {
    let status = r.status();
    let text = r.text().await.unwrap();
    assert_eq!(status, 200, "{text}");
    serde_json::from_str(&text).unwrap()
}
fn draft(materials: bool) -> Value {
    let date = chrono::Utc::now().date_naive();
    json!({"version":0,"mandate":{"maximum":{"minor":45000,"currency":"JPY"},"country_code":"JP","city":"Tokyo",
        "area":{"latitude":35.658,"longitude":139.7,"radius_meters":1500},"check_in":(date+chrono::Duration::days(14)).to_string(),"check_out":(date+chrono::Duration::days(16)).to_string(),
        "rooms":1,"guests":[{"type":"adult"}],"require_refundable":true,"accommodation_ids":[],"minimum_rating":3,"preferences":[],"amenity_preferences":["quiet"],"bed_type":"double","substitution_tolerance":"within_area","spend_capability_id":"fixture-balance"},
        "travelers":[{"given_name":"Ada","family_name":"Fixture","email":"ada@example.test","phone":"+442080160509","born_on":"1980-01-01"}],"materials":materials})
}
async fn setup(materials: bool, port: u16) -> Trip {
    let s = TestServer::start_with(|s| {
        s.travel_fixtures = true;
        s.kikka = Some(Kikka {
            binary: PathBuf::new(),
            home: PathBuf::new(),
            user: "*".into(),
            orb: "pi".into(),
            model: "fixture".into(),
            verify: String::new(),
            lock: Default::default(),
            routing: None,
            pi: Some(Pi {
                endpoint: format!("http://127.0.0.1:{port}/command"),
                token: WORKER.into(),
            }),
        });
    })
    .await;
    let hash = server::auth::hash_password("test-password").unwrap();
    for user in ["pilot", "outsider"] {
        sqlx::query("INSERT INTO users(id,username,display_name,password_hash,created_at) VALUES(?,?,?,?,0)").bind(user).bind(user).bind(user).bind(&hash).execute(&s.state.db).await.unwrap();
    }
    let secret = server::auth::jwt_secret();
    let owner = server::auth::create_token("pilot", 0, &secret).unwrap();
    let other = server::auth::create_token("outsider", 0, &secret).unwrap();
    let task = ok(s
        .post_json_auth(
            "/api/v1/burrow/tasks",
            &owner,
            json!({"request":"Find and book a refundable room inside my Shibuya limits."}),
        )
        .await)
    .await;
    let id = task["id"].as_str().unwrap().to_owned();
    let saved = ok(s
        .post_json_auth(
            &format!("/api/v1/burrow/tasks/{id}/travel"),
            &owner,
            draft(materials),
        )
        .await)
    .await;
    assert_eq!(saved["task"]["travel"], true);
    let run = ok(s
        .post_json_auth(
            &format!("/api/v1/burrow/tasks/{id}/agent"),
            &owner,
            json!({"version":saved["task"]["version"],"allow_agent":true,"max_cost_cents":37}),
        )
        .await)
    .await;
    let root: String = sqlx::query_scalar("SELECT root_goal FROM burrow_agent_runs WHERE id=?")
        .bind(run["id"].as_str().unwrap())
        .fetch_one(&s.state.db)
        .await
        .unwrap();
    // Most cases exercise the trusted capability boundary directly. The real
    // bridge case leaves the run queued and performs actual start/recovery below.
    if port == 1 {
        sqlx::query("UPDATE burrow_agent_runs SET phase='attached' WHERE task_id=?")
            .bind(&id)
            .execute(&s.state.db)
            .await
            .unwrap();
    }
    Trip {
        s,
        owner,
        other,
        id,
        workspace: saved["workspace_id"].as_str().unwrap().into(),
        root,
    }
}
impl Trip {
    fn route(&self, suffix: &str) -> String {
        format!("/api/v1/burrow/tasks/{}/{}", self.id, suffix)
    }
    fn command(&self, op: &str, id: &str, args: Value) -> Value {
        json!({"owner":"pilot","task":self.id,"root_goal":self.root,"workspace_id":self.workspace,"request_id":id,"operation":op,"args":args})
    }
    async fn call(&self, op: &str, id: &str, args: Value) -> Value {
        ok(self
            .s
            .post_json_auth(
                "/api/v1/burrow/internal/travel",
                WORKER,
                self.command(op, id, args),
            )
            .await)
        .await
    }
    async fn view(&self) -> Value {
        ok(self.s.get_auth(&self.route("travel"), &self.owner).await).await
    }
    async fn fault(&self, fault: &str) {
        sqlx::query("UPDATE burrow_travel_requests SET fixture_fault=? WHERE task_id=?")
            .bind(fault)
            .bind(&self.id)
            .execute(&self.s.state.db)
            .await
            .unwrap();
    }
    async fn select(&self, id: &str) -> Value {
        self.call(
            "select",
            id,
            json!({"rate_id":"rate_excel","reason":"Lowest admitted total and refundable."}),
        )
        .await
    }
    async fn count(&self, table: &str) -> i64 {
        sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&self.s.state.db)
            .await
            .unwrap()
    }
    async fn stop(&self) {
        let v = ok(self.s.get_auth(&self.route("agent"), &self.owner).await).await;
        ok(self
            .s
            .post_json_auth(
                &self.route("agent/control"),
                &self.owner,
                json!({"version":v["task"]["version"],"request_id":"human-stop","action":"stop"}),
            )
            .await)
        .await;
    }
    async fn expire_quote(&self) {
        sqlx::query("UPDATE burrow_travel_transactions SET body=json_set(body,'$.quote.valid_until',0) WHERE task_id=?").bind(&self.id).execute(&self.s.state.db).await.unwrap();
    }
}

#[tokio::test]
async fn admitted_inventory_materials_prices_scope_and_saved_revisions() {
    let t = setup(true, 1).await;
    let model = t.call("research", "research", json!({})).await;
    assert_eq!(model["stage"], "comparing");
    assert_eq!(model["comparison"]["options"].as_array().unwrap().len(), 3);
    assert!(model["comparison"]["context"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(!model.to_string().contains("\"low\""));
    let user = t.view().await;
    assert_eq!(
        user["comparison"]["context"][0]["name"],
        "Fictional Kyoto Garden"
    );
    assert_eq!(
        user["comparison"]["options"][2]["materials"][0]["confidence"],
        "low"
    );
    assert_eq!(
        user["comparison"]["options"][1]["materials"][0]["confidence"],
        "high"
    );
    assert_eq!(
        user["comparison"]["options"][1]["materials"][0]["material"]["scope"]["root_goal_id"],
        t.root
    );
    assert_eq!(t.select("select").await["stage"], "quoting");
    let booked = t.call("book", "book", json!({})).await;
    assert_eq!(booked["stage"], "completed", "{booked}");
    assert!(booked["result"]["booking"].get("email").is_none());
    assert!(!booked.to_string().contains("ada@example.test"));
    let user = t.view().await;
    assert_eq!(user["result"]["final_quote"]["total"]["minor"], 34000);
    assert_eq!(user["result"]["research_price"]["minor"], 32000);
    assert_eq!(user["result"]["research_to_quote_difference_minor"], 2000);
    assert_eq!(user["result"]["booking"]["guests"][0]["given_name"], "Ada");
    assert_eq!(user["root_goal_id"], t.root);
    assert_eq!(user["result"]["scope"]["root_goal_id"], t.root);
    assert_eq!(t.call("book", "book", json!({})).await, booked);
    assert_eq!(
        t.call("book", "another-book", json!({})).await["stage"],
        "completed"
    );
    assert_eq!(t.count("burrow_travel_fixture_bookings").await, 1);
    assert_eq!(t.count("burrow_travel_spend").await, 1);
    let view = ok(t.s.get_auth(&t.route("agent"), &t.owner).await).await;
    assert_eq!(
        serde_json::from_str::<Value>(view["task"]["result"].as_str().unwrap()).unwrap(),
        user
    );
    let changed = ok(t
        .s
        .client
        .patch(t.s.url(&t.route("result")))
        .bearer_auth(&t.owner)
        .json(&json!({"version":view["task"]["version"],"result":"My manual note"}))
        .send()
        .await
        .unwrap())
    .await;
    assert_eq!(changed["result"], "My manual note");
    t.call("status", "new-status", json!({})).await;
    let revised = ok(t.s.get_auth(&t.route("agent"), &t.owner).await).await;
    assert_eq!(revised["task"]["result"], "My manual note");
    assert_eq!(
        serde_json::from_str::<Value>(revised["task"]["proposed_result"].as_str().unwrap())
            .unwrap()["stage"],
        "completed"
    );
    assert!(!revised["history"].as_array().unwrap().is_empty());
    // A completed fixture must not strand traveler PII behind non-cascading FKs.
    sqlx::query("UPDATE burrow_agent_runs SET phase='finished' WHERE task_id=?")
        .bind(&t.id)
        .execute(&t.s.state.db)
        .await
        .unwrap();
    let deleted =
        t.s.client
            .delete(t.s.url("/api/v1/users/@me"))
            .bearer_auth(&t.owner)
            .json(&json!({"password":"test-password","username":"pilot"}))
            .send()
            .await
            .unwrap();
    assert_eq!(deleted.status(), 204, "{}", deleted.text().await.unwrap());
    for table in [
        "burrow_travel_profiles",
        "burrow_travel_requests",
        "burrow_travel_transactions",
        "burrow_travel_actions",
        "burrow_travel_fixture_bookings",
    ] {
        assert_eq!(t.count(table).await, 0);
    }
}

#[tokio::test]
async fn provider_only_flow_and_context_cannot_become_bookable() {
    let t = setup(false, 1).await;
    let v = t.call("research", "research", json!({})).await;
    assert!(v["comparison"]["options"]
        .as_array()
        .unwrap()
        .iter()
        .all(|o| o["materials"].as_array().unwrap().is_empty()));
    t.select("select").await;
    let done = t.call("book", "book", json!({})).await;
    assert_eq!(done["stage"], "completed");
    assert!(done["result"]["research_price"].is_null());
    let other = setup(true, 1).await;
    other.call("research", "research", json!({})).await;
    let rejected = other
        .call(
            "select",
            "invented",
            json!({"rate_id":"Fictional Kyoto Garden","reason":"Research was cheaper"}),
        )
        .await;
    assert_eq!(rejected["stage"], "outside_mandate");
    assert_eq!(other.count("burrow_travel_fixture_bookings").await, 0);
}

#[tokio::test]
async fn fresh_and_expired_quotes_never_exceed_mandate() {
    for (expired, high) in [(false, true), (true, false), (true, true)] {
        let t = setup(false, 1).await;
        t.call("research", "research", json!({})).await;
        if !expired {
            t.fault("quote_high").await;
        }
        let selected = t.select("select").await;
        if expired {
            t.expire_quote().await;
            if high {
                t.fault("quote_high").await;
            }
        }
        let result = if expired {
            t.call("book", "book", json!({})).await
        } else {
            selected
        };
        assert_eq!(
            result["stage"],
            if high { "outside_mandate" } else { "completed" },
            "{result}"
        );
        assert_eq!(
            t.count("burrow_travel_fixture_bookings").await,
            if high { 0 } else { 1 }
        );
        if high {
            assert_eq!(t.count("burrow_travel_spend").await, 0);
        }
    }
}

#[tokio::test]
async fn uncertain_ack_reconciliation_stop_and_timeout_preserve_holds() {
    for fault in ["lost_ack", "lost_ack_absent"] {
        let t = setup(true, 1).await;
        t.call("research", "research", json!({})).await;
        t.select("select").await;
        t.fault(fault).await;
        assert_eq!(
            t.call("book", "book", json!({})).await["stage"],
            "booking_uncertain"
        );
        t.stop().await;
        assert_eq!(t.view().await["stage"], "booking_uncertain");
        let result = t.call("reconcile", "recover", json!({})).await;
        if fault == "lost_ack" {
            assert_eq!(result["stage"], "completed", "{result}");
            assert_eq!(t.count("burrow_travel_fixture_bookings").await, 1);
        } else {
            assert_eq!(result["stage"], "booking_uncertain");
            assert_eq!(
                t.s.post_empty_auth(&t.route("travel/retry"), &t.owner)
                    .await
                    .status(),
                409
            );
            sqlx::query(
                "UPDATE burrow_travel_transactions SET reconcile_started_at=? WHERE task_id=?",
            )
            .bind(server::types::now_unix() - 901)
            .bind(&t.id)
            .execute(&t.s.state.db)
            .await
            .unwrap();
            assert_eq!(
                t.call("reconcile", "timeout", json!({})).await["stage"],
                "unresolved_needs_attention"
            );
            let hold: String = sqlx::query_scalar("SELECT state FROM burrow_travel_spend")
                .fetch_one(&t.s.state.db)
                .await
                .unwrap();
            assert_eq!(hold, "reserved");
            assert_eq!(t.count("burrow_travel_fixture_bookings").await, 0);
        }
    }
}

#[tokio::test]
async fn proven_no_booking_failure_requires_human_retry_and_new_quote() {
    let t = setup(false, 1).await;
    t.call("research", "research", json!({})).await;
    t.select("select").await;
    t.fault("reject_once").await;
    assert_eq!(
        t.call("book", "book", json!({})).await["stage"],
        "provider_failure"
    );
    t.select("unapproved-retry").await;
    assert_eq!(t.count("burrow_travel_fixture_bookings").await, 0);
    let approved = ok(t
        .s
        .post_empty_auth(&t.route("travel/retry"), &t.owner)
        .await)
    .await;
    assert_eq!(approved["stage"], "comparing");
    assert_eq!(t.select("approved-quote").await["stage"], "quoting");
    assert_eq!(
        t.call("book", "approved-book", json!({})).await["stage"],
        "completed"
    );
    assert_eq!(t.count("burrow_travel_fixture_bookings").await, 1);
}

#[tokio::test]
async fn human_stop_before_research_and_after_comparison_fences_worker_independently() {
    for research in [false, true] {
        let t = setup(true, 1).await;
        if research {
            t.call("research", "research", json!({})).await;
        }
        t.stop().await;
        assert_eq!(t.view().await["stage"], "stopped");
        assert_eq!(
            t.call("research", "late-research", json!({})).await["stage"],
            "stopped"
        );
        assert_eq!(t.select("late-select").await["stage"], "stopped");
        assert_eq!(
            t.call("book", "late-book", json!({})).await["stage"],
            "stopped"
        );
        assert_eq!(t.count("burrow_travel_spend").await, 0);
    }
    let t = setup(true, 1).await;
    t.fault("slow_search").await;
    let work = t.call("research", "inflight", json!({}));
    let stop = async {
        for _ in 0..100 {
            if t.view().await["stage"] == "researching" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(t.view().await["stage"], "researching");
        t.stop().await;
    };
    let (finished, ()) = tokio::join!(work, stop);
    assert_eq!(finished["stage"], "stopped");
    assert!(finished["comparison"]["options"]
        .as_array()
        .unwrap()
        .is_empty());
    assert_eq!(t.count("burrow_travel_spend").await, 0);
}

#[tokio::test]
async fn fixture_gate_provider_failure_and_ambiguous_name_matching_fail_closed() {
    let off = TestServer::start_with(|s| s.travel_fixtures = false).await;
    let denied=off.post_json_auth("/api/v1/burrow/internal/travel",WORKER,json!({"owner":"x","task":"x","root_goal":"x","workspace_id":"x","request_id":"x","operation":"status","args":{}})).await;
    assert_eq!(denied.status(), 503);
    let t = setup(true, 1).await;
    t.fault("search_failure").await;
    assert_eq!(
        t.call("research", "failure", json!({})).await["stage"],
        "provider_failure"
    );
    assert_eq!(t.count("burrow_travel_spend").await, 0);
    let t = setup(true, 1).await;
    t.call("research", "research", json!({})).await;
    use server::api::burrow::travel::{
        workflow::{match_materials, Comparison},
        TravelArea,
    };
    let comparison: Comparison =
        serde_json::from_value(t.view().await["comparison"].clone()).unwrap();
    let a = comparison.options[1].rate.clone();
    let material = comparison.options[1].materials[0].material.clone();
    let mut b = a.clone();
    b.accommodation.id = "different-property".into();
    b.rate_id = "different-rate".into();
    let area = TravelArea {
        latitude: 35.658,
        longitude: 139.7,
        radius_meters: 1500.0,
    };
    let ambiguous = match_materials(vec![a.clone(), b], vec![material.clone()], &area);
    assert!(ambiguous
        .options
        .iter()
        .all(|o| o.materials[0].confidence == "low"));
    let mut reordered = material;
    reordered.name = "Excel Shibuya Fictional".into();
    assert_eq!(
        match_materials(vec![a], vec![reordered], &area).options[0].materials[0].confidence,
        "low"
    );
}

#[tokio::test]
async fn model_widening_identity_replay_and_account_access_are_rejected() {
    let t = setup(true, 1).await;
    let research = t.call("research", "same", json!({})).await;
    for key in ["owner", "root_goal", "workspace_id", "task"] {
        let mut body = t.command("status", "other", json!({}));
        body[key] = json!("outsider");
        assert_eq!(
            t.s.post_json_auth("/api/v1/burrow/internal/travel", WORKER, body)
                .await
                .status(),
            404
        );
    }
    assert_eq!(
        t.s.post_json_auth(
            "/api/v1/burrow/internal/travel",
            &t.owner,
            t.command("book", "forged", json!({}))
        )
        .await
        .status(),
        401
    );
    assert_eq!(
        t.s.post_json_auth(
            "/api/v1/burrow/internal/travel",
            WORKER,
            t.command(
                "select",
                "widen",
                json!({"rate_id":"rate_excel","reason":"cheap","maximum":999999})
            )
        )
        .await
        .status(),
        409
    );
    assert_eq!(
        t.s.post_json_auth(
            "/api/v1/burrow/internal/travel",
            WORKER,
            t.command("book", "same", json!({}))
        )
        .await
        .status(),
        409
    );
    assert_eq!(t.call("research", "same", json!({})).await, research);
    for route in ["travel", "agent"] {
        assert_eq!(t.s.get_auth(&t.route(route), &t.other).await.status(), 404);
    }
    assert_eq!(
        t.s.post_json_auth(&t.route("travel"), &t.other, draft(true))
            .await
            .status(),
        404
    );
    let mut widen = draft(true);
    widen["version"] = json!(2);
    widen["mandate"]["maximum"]["minor"] = json!(999999);
    assert_eq!(
        t.s.post_json_auth(&t.route("travel"), &t.owner, widen)
            .await
            .status(),
        409
    );
    assert_eq!(t.count("burrow_travel_fixture_bookings").await, 0);
}

#[tokio::test]
async fn real_pi_bridge_recovers_after_committed_quote_and_publishes_one_booking() {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    let t = setup(true, port).await;
    struct Home(PathBuf);
    impl Drop for Home {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let home = Home(std::env::temp_dir().join(format!("travel-pi-{}", uuid::Uuid::new_v4())));
    std::fs::create_dir_all(&home.0).unwrap();
    let pause = home.0.join("pause");
    let script =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../worker/test/fixtures/travel-worker.mjs");
    let spawn = || {
        tokio::process::Command::new("node")
            .arg(&script)
            .arg(&t.s.base)
            .arg(home.0.join("pi"))
            .arg(port.to_string())
            .arg(&pause)
            .kill_on_drop(true)
            .spawn()
            .unwrap()
    };
    let mut worker = spawn();
    for _ in 0..300 {
        if t.s
            .client
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .await
            .is_ok()
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    agent::tick(&t.s.state).await.unwrap();
    for _ in 0..500 {
        if pause.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        pause.exists(),
        "Pi must reach a committed quote before simulated process loss"
    );
    worker.kill().await.unwrap();
    worker.wait().await.unwrap();
    assert_eq!(t.count("burrow_travel_spend").await, 0);
    let mut worker = spawn();
    let mut complete = false;
    for _ in 0..500 {
        agent::tick(&t.s.state).await.unwrap();
        let view = ok(t.s.get_auth(&t.route("agent"), &t.owner).await).await;
        if view["agent"]["phase"] == "finished" {
            assert_eq!(view["task"]["state"], "draft_ready");
            complete = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    worker.kill().await.unwrap();
    worker.wait().await.unwrap();
    assert!(complete, "real Pi did not finish");
    assert_eq!(t.view().await["stage"], "completed");
    assert_eq!(t.count("burrow_travel_fixture_bookings").await, 1);
    assert_eq!(t.count("burrow_travel_spend").await, 1);
    let saved = ok(t.s.get_auth(&t.route("agent"), &t.owner).await).await;
    assert_eq!(
        serde_json::from_str::<Value>(saved["task"]["result"].as_str().unwrap()).unwrap()["result"]
            ["scope"]["root_goal_id"],
        t.root
    );
}
