mod common;
use common::TestServer;
use serde_json::{json, Value};
use server::api::burrow::{
    agent::{Kikka, Pi},
    routing::{Config, Routing},
};

const OUTLINE: &str = "Introduction for the class.\n## Slide 1: Water & air\nWater evaporates.\n**Speaker notes:** Ask about a drying puddle.\n## Slide 2: Clouds\nWater condenses.";
async fn task(s: &TestServer, token: &str, project: &str, page: bool) -> String {
    let mut body = json!({"request":"A school presentation", "project":project});
    if page {
        body["format"] = json!("creation");
        body["example"] = json!("quiz");
    }
    let r = s.post_json_auth("/api/v1/burrow/tasks", token, body).await;
    assert_eq!(r.status(), 200);
    let id = r.json::<Value>().await.unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    if !page {
        sqlx::query("UPDATE burrow_tasks SET state='draft_ready',result=? WHERE id=?")
            .bind(OUTLINE)
            .bind(&id)
            .execute(&s.state.db)
            .await
            .unwrap();
    }
    id
}
fn review(action: &str, version: i64, revision: i64) -> Value {
    json!({"action":action,"version":version,"revision":revision,"audience":"Year 5, ages 9–10","citations":[{"claim":"Slide 1: water evaporates","title":"Water cycle","url":"https://example.org/water?x=1&y=2","quote":"Water changes from liquid to vapour.","checked":true}],"facts_checked":true,"age_checked":true,"school_use_approved":true})
}
async fn get(s: &TestServer, token: &str, id: &str) -> Value {
    s.get_auth(&format!("/api/v1/burrow/tasks/{id}/presentation"), token)
        .await
        .json()
        .await
        .unwrap()
}
async fn change(s: &TestServer, token: &str, id: &str, body: Value) -> reqwest::Response {
    s.post_json_auth(
        &format!("/api/v1/burrow/tasks/{id}/presentation"),
        token,
        body,
    )
    .await
}
#[tokio::test]
async fn export_requires_exact_human_signoff_persists_and_rollback_cannot_resurrect_approval() {
    let s = TestServer::start().await;
    let a = s.register("presentation_owner", "test-password").await;
    let b = s.register("presentation_other", "test-password").await;
    let id = task(&s, &a.token, "School", false).await;
    let sibling = task(&s, &a.token, "School", false).await;
    let other_project = task(&s, &a.token, "Other", false).await;
    let path = format!("/api/v1/burrow/tasks/{id}/presentation/export");
    assert_eq!(s.get_auth(&path, &a.token).await.status(), 409);
    for suffix in ["presentation", "presentation/export"] {
        assert_eq!(
            s.get_auth(&format!("/api/v1/burrow/tasks/{id}/{suffix}"), &b.token)
                .await
                .status(),
            404
        );
    }
    assert_eq!(
        change(&s, &b.token, &id, review("approve", 0, 0))
            .await
            .status(),
        404
    );
    assert_eq!(
        change(&s, &a.token, &id, review("save", 0, 0))
            .await
            .status(),
        200
    );
    assert_eq!(get(&s, &a.token, &id).await["approved"], false);
    assert_eq!(
        change(&s, &a.token, &id, review("approve", 0, 0))
            .await
            .status(),
        409
    );
    assert_eq!(
        change(&s, &a.token, &id, review("approve", 0, 1))
            .await
            .status(),
        200
    );
    let exported: Value = s.get_auth(&path, &a.token).await.json().await.unwrap();
    assert_eq!(exported["content"], OUTLINE);
    assert_eq!(
        exported["citations"][0]["quote"],
        "Water changes from liquid to vapour."
    );
    assert_eq!(exported["audience"], "Year 5, ages 9–10");
    assert_eq!(get(&s, &a.token, &sibling).await["approved"], false);
    assert_eq!(
        get(&s, &a.token, &other_project).await["history"],
        json!([])
    );
    let pool = server::db::connect(s.db_url()).await.unwrap();
    assert_eq!(sqlx::query_scalar::<_,String>("SELECT status FROM burrow_presentation_reviews WHERE task_id=? ORDER BY revision DESC LIMIT 1").bind(&id).fetch_one(&pool).await.unwrap(), "approved");
    assert_eq!(
        change(&s, &a.token, &id, review("withdraw", 0, 2))
            .await
            .status(),
        200
    );
    assert_eq!(s.get_auth(&path, &a.token).await.status(), 409);
    assert_eq!(
        get(&s, &a.token, &id).await["history"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert_eq!(
        change(&s, &a.token, &id, review("approve", 0, 3))
            .await
            .status(),
        200
    );
    let edited = s
        .patch_json_auth(
            &format!("/api/v1/burrow/tasks/{id}/result"),
            &a.token,
            json!({"version":0,"result":"## Slide 1: Changed\nA new claim."}),
        )
        .await;
    assert_eq!(edited.status(), 200);
    assert_eq!(get(&s, &a.token, &id).await["approved"], false);
    assert_eq!(s.get_auth(&path, &a.token).await.status(), 409);
    // Restoring the exact text is still a new material version, not old consent.
    assert_eq!(
        s.patch_json_auth(
            &format!("/api/v1/burrow/tasks/{id}/result"),
            &a.token,
            json!({"version":1,"result":OUTLINE})
        )
        .await
        .status(),
        200
    );
    assert_eq!(s.get_auth(&path, &a.token).await.status(), 409);
    assert_eq!(
        change(&s, &a.token, &id, review("approve", 0, 4))
            .await
            .status(),
        409
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM burrow_agent_runs")
            .fetch_one(&s.state.db)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn citations_and_all_attestations_are_required_and_pages_export_only_the_approved_saved_content(
) {
    let s = TestServer::start().await;
    let a = s.register("citation_owner", "test-password").await;
    let id = task(&s, &a.token, "Sources", true).await;
    for field in ["facts_checked", "age_checked", "school_use_approved"] {
        let mut body = review("approve", 0, 0);
        body[field] = json!(false);
        assert_eq!(
            change(&s, &a.token, &id, body).await.status(),
            400,
            "{field}"
        );
    }
    for url in [
        "javascript:alert(1)",
        "data:text/html,bad",
        "file:///etc/passwd",
        "https://user:password@example.com",
        "invalid",
    ] {
        let mut body = review("approve", 0, 0);
        body["citations"][0]["url"] = json!(url);
        assert_eq!(change(&s, &a.token, &id, body).await.status(), 400, "{url}");
    }
    for field in ["claim", "title", "quote"] {
        let mut body = review("approve", 0, 0);
        body["citations"][0][field] = json!("");
        assert_eq!(change(&s, &a.token, &id, body).await.status(), 400);
    }
    let mut body = review("approve", 0, 0);
    body["citations"][0]["checked"] = json!(false);
    assert_eq!(change(&s, &a.token, &id, body).await.status(), 400);
    let mut body = review("approve", 0, 0);
    body["citations"] = json!([]);
    assert_eq!(change(&s, &a.token, &id, body).await.status(), 400);
    let mut body = review("approve", 0, 0);
    body["install"] = json!(true);
    assert_eq!(change(&s, &a.token, &id, body).await.status(), 422);
    assert_eq!(
        change(&s, &a.token, &id, review("approve", 0, 0))
            .await
            .status(),
        200
    );
    let exported: Value = s
        .get_auth(
            &format!("/api/v1/burrow/tasks/{id}/presentation/export"),
            &a.token,
        )
        .await
        .json()
        .await
        .unwrap();
    let stored: String = sqlx::query_scalar("SELECT result FROM burrow_tasks WHERE id=?")
        .bind(&id)
        .fetch_one(&s.state.db)
        .await
        .unwrap();
    assert_eq!(exported["format"], "creation");
    assert_eq!(exported["content"], stored);
    assert!(serde_json::from_str::<Value>(&stored).unwrap()["page"].is_object());
}

fn kikka() -> Kikka {
    let config: Config = serde_json::from_str(include_str!(
        "../../worker/test/fixtures/project-routing.json"
    ))
    .unwrap();
    Kikka {
        binary: Default::default(),
        home: Default::default(),
        user: "*".into(),
        orb: "pi".into(),
        model: "fixture".into(),
        verify: String::new(),
        lock: Default::default(),
        pi: Some(Pi {
            endpoint: "http://127.0.0.1:1/command".into(),
            token: "f".repeat(32),
        }),
        routing: Some(
            Routing::new(
                config,
                None,
                [("school-fixture".into(), "fixture-key".into())].into(),
            )
            .unwrap(),
        ),
    }
}
#[tokio::test]
async fn evaluation_requires_consent_pins_budget_model_snapshot_and_no_tool_scope_without_reset_or_fallback(
) {
    let s = TestServer::start_with(|s| s.kikka = Some(kikka())).await;
    let a = s.register("evaluation_owner", "test-password").await;
    let b = s.register("evaluation_other", "test-password").await;
    let id = task(&s, &a.token, "School", false).await;
    assert_eq!(
        change(&s, &a.token, &id, review("save", 0, 0))
            .await
            .status(),
        200
    );
    let routes: Value = s
        .get_auth("/api/v1/burrow/model-routing", &a.token)
        .await
        .json()
        .await
        .unwrap();
    let body = json!({"version":0,"revision":1,"allow_evaluation":true,"max_cost_cents":7,"routing":routes["preview"]});
    let path = format!("/api/v1/burrow/tasks/{id}/presentation/evaluate");
    for (field, value) in [
        ("allow_evaluation", json!(false)),
        ("max_cost_cents", json!(-1)),
        ("max_cost_cents", json!(51)),
        ("version", json!(1)),
        ("revision", json!(0)),
        ("routing", json!({})),
    ] {
        let mut denied = body.clone();
        denied[field] = value;
        assert!(s
            .post_json_auth(&path, &a.token, denied)
            .await
            .status()
            .is_client_error());
    }
    assert_eq!(
        s.post_json_auth(&path, &b.token, body.clone())
            .await
            .status(),
        404
    );
    assert_eq!(
        sqlx::query_scalar::<_, i64>("SELECT count(*) FROM burrow_agent_runs")
            .fetch_one(&s.state.db)
            .await
            .unwrap(),
        0
    );
    let accepted = s.post_json_auth(&path, &a.token, body.clone()).await;
    assert_eq!(
        accepted.status(),
        200,
        "{}",
        accepted.text().await.unwrap_or_default()
    );
    let saved = get(&s, &a.token, &id).await;
    assert_eq!(saved["approved"], false);
    let eval = saved["evaluation"]["id"].as_str().unwrap();
    let run: Value = s
        .get_auth(&format!("/api/v1/burrow/tasks/{eval}/agent"), &a.token)
        .await
        .json()
        .await
        .unwrap();
    assert_eq!(run["agent"]["max_cost_cents"], 7);
    assert_eq!(run["agent"]["role"], "review");
    assert_eq!(run["agent"]["project_knowledge"], false);
    assert!(run["agent"]["computer_workspace"].is_null());
    assert_eq!(saved["evaluation"]["version"], run["task"]["version"]);
    let workspace: Value = s
        .get_auth("/api/v1/burrow", &a.token)
        .await
        .json()
        .await
        .unwrap();
    assert!(
        workspace["tasks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t["id"] != eval),
        "derived reports stay inside the presentation, not in the chat list"
    );
    assert_eq!(
        s.patch_json_auth(
            &format!("/api/v1/burrow/tasks/{eval}/result"),
            &a.token,
            json!({"version":run["task"]["version"],"result":"Forged AI report"})
        )
        .await
        .status(),
        403
    );
    assert_eq!(
        s.post_json_auth(&path, &a.token, body.clone())
            .await
            .status(),
        409
    );
    let mut raised = body.clone();
    raised["max_cost_cents"] = json!(50);
    assert_eq!(
        s.post_json_auth(&path, &a.token, raised).await.status(),
        409
    );
    let agent_path = format!("/api/v1/burrow/tasks/{eval}/agent");
    for change in [
        json!({"max_cost_cents":50}),
        json!({"allow_project_knowledge":true}),
        json!({"computer_workspace":"injected"}),
        json!({"role":"general"}),
    ] {
        let mut escalated = json!({"version":0,"allow_agent":true,"max_cost_cents":7,"role":"review","routing":routes["preview"]});
        escalated
            .as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        assert_eq!(
            s.post_json_auth(&agent_path, &a.token, escalated)
                .await
                .status(),
            400
        );
    }
    assert_eq!(s.post_json_auth(&format!("{agent_path}/control"),&a.token,json!({"version":1,"request_id":"new-request","action":"continue","message":"Spend more","allow_spending":true})).await.status(),409);
    assert_eq!(
        s.post_json_auth(
            &format!("/api/v1/burrow/tasks/{eval}/run"),
            &a.token,
            json!({"allow_generation":true})
        )
        .await
        .status(),
        409
    );
    assert_eq!(get(&s, &a.token, &id).await["review"]["status"], "draft");
}
