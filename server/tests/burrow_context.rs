//! Real authenticated API and SQLite; no inference or invented live evidence.
mod common;
use common::TestServer;
use serde_json::{json, Value};

async fn create(s: &TestServer, token: &str, project: &str) -> Value {
    let r = s
        .post_json_auth(
            "/api/v1/burrow/tasks",
            token,
            json!({"request":"Compare cotton suppliers","project":project,"comparison":true}),
        )
        .await;
    assert_eq!(r.status(), 200);
    r.json().await.unwrap()
}
async fn context(s: &TestServer, token: &str, id: &str, q: &str) -> Value {
    let r = s
        .get_auth(&format!("/api/v1/burrow/tasks/{id}/context?q={q}"), token)
        .await;
    assert_eq!(r.status(), 200);
    r.json().await.unwrap()
}
async fn patch(s: &TestServer, token: &str, path: &str, body: Value) -> reqwest::Response {
    s.client
        .patch(format!("{}{path}", s.base))
        .bearer_auth(token)
        .json(&body)
        .send()
        .await
        .unwrap()
}

#[tokio::test]
async fn scoped_memory_correction_forget_search_and_routines_survive_reopen_without_inference() {
    let s = TestServer::start().await;
    let owner = s.register("memory_owner", "test-password").await;
    let outsider = s.register("memory_other", "test-password").await;
    let a = create(&s, &owner.token, "Supplier launch").await;
    let b = create(&s, &owner.token, "Unrelated trip").await;
    let id = a["id"].as_str().unwrap();
    let bid = b["id"].as_str().unwrap();
    let root = format!("/api/v1/burrow/tasks/{id}");
    let r = s
        .post_json_auth(
            &format!("{root}/memories"),
            &owner.token,
            json!({"text":"100% cotton and delivery to Canada"}),
        )
        .await;
    assert_eq!(r.status(), 200);
    let memory: Value = r.json().await.unwrap();
    let mid = memory["id"].as_str().unwrap();
    assert_eq!(
        context(&s, &owner.token, id, "").await["memories"][0]["project"],
        "Supplier launch"
    );
    assert_eq!(
        context(&s, &owner.token, bid, "").await["memories"],
        json!([])
    );
    assert_eq!(
        s.get_auth(&format!("{root}/context?q=cotton"), &outsider.token)
            .await
            .status(),
        404
    );
    assert_eq!(
        s.post_json_auth(
            &format!("{root}/memories"),
            &outsider.token,
            json!({"text":"attack"})
        )
        .await
        .status(),
        404
    );
    let path = format!("/api/v1/burrow/memories/{mid}");
    assert_eq!(
        patch(
            &s,
            &outsider.token,
            &path,
            json!({"version":1,"text":"attack"})
        )
        .await
        .status(),
        409
    );
    assert_eq!(
        patch(
            &s,
            &owner.token,
            &path,
            json!({"version":1,"text":"100% linen and delivery to Canada"})
        )
        .await
        .status(),
        200
    );
    assert_eq!(
        patch(
            &s,
            &owner.token,
            &path,
            json!({"version":1,"text":"stale cotton"})
        )
        .await
        .status(),
        409
    );
    let c = context(&s, &owner.token, id, "").await;
    assert_eq!(
        c["memories"][0]["text"],
        "100% linen and delivery to Canada"
    );
    assert_eq!(c["memories"][0]["version"], 2);
    // Personal is explicit and distinct from the supplier project.
    assert_eq!(
        s.post_json_auth(
            &format!("{root}/memories"),
            &owner.token,
            json!({"text":"Keep explanations short","personal":true})
        )
        .await
        .status(),
        200
    );
    assert_eq!(
        context(&s, &owner.token, bid, "").await["memories"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    // No provider call is needed to save, search, correct, forget, or save methods.
    sqlx::query("UPDATE burrow_tasks SET state='draft_ready',result='Cotton supplier result: MOQ 25, evidence required' WHERE id=?").bind(id).execute(&s.state.db).await.unwrap();
    assert_eq!(
        context(&s, &owner.token, id, "MOQ").await["history"][0][0],
        id
    );
    assert_eq!(
        context(&s, &owner.token, bid, "MOQ").await["history"],
        json!([])
    );
    let r=s.post_json_auth(&format!("{root}/routine"),&owner.token,json!({"name":"Supplier comparison","instructions":"Compare material and MOQ; collect fresh evidence."})).await;
    assert_eq!(r.status(), 200);
    let routine: Value = r.json().await.unwrap();
    let r=s.post_json_auth("/api/v1/burrow/tasks",&owner.token,json!({"request":"Compare new pages","project":"Supplier launch","comparison":true,"routine_id":routine["id"]})).await;
    assert_eq!(r.status(), 200);
    let reuse: Value = r.json().await.unwrap();
    assert_eq!(reuse["routine_version"], 1);
    assert_eq!(reuse["result"], "");
    assert_eq!(reuse["state"], "waiting");
    for (token, project) in [
        (&outsider.token, "Supplier launch"),
        (&owner.token, "Unrelated trip"),
    ] {
        assert_eq!(s.post_json_auth("/api/v1/burrow/tasks",token,json!({"request":"Steal routine","project":project,"comparison":true,"routine_id":routine["id"]})).await.status(),404);
    }
    // Tombstone prevents update/revival; no summary cache or auto-extraction exists.
    assert_eq!(
        patch(&s, &owner.token, &path, json!({"version":2,"text":null}))
            .await
            .status(),
        200
    );
    let reopened = server::db::connect(s.db_url()).await.unwrap();
    assert_eq!(
        sqlx::query_scalar::<_, String>("SELECT text FROM burrow_memories WHERE id=?")
            .bind(mid)
            .fetch_one(&reopened)
            .await
            .unwrap(),
        ""
    );
    assert_eq!(
        context(&s, &owner.token, id, "").await["memories"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        patch(
            &s,
            &owner.token,
            &path,
            json!({"version":3,"text":"resurrect"})
        )
        .await
        .status(),
        409
    );
    assert_eq!(
        context(&s, &owner.token, id, "MOQ").await["history"][0][0],
        id,
        "forget is not history deletion"
    );
    assert_eq!(
        context(&s, &owner.token, id, "").await["routines"][0][0],
        routine["id"]
    );
}

#[tokio::test]
async fn notes_and_manual_edits_use_versions_and_revision_requires_explicit_acceptance() {
    let s = TestServer::start().await;
    let owner = s.register("editor_owner", "test-password").await;
    let task = create(&s, &owner.token, "Suppliers").await;
    let id = task["id"].as_str().unwrap();
    let root = format!("/api/v1/burrow/tasks/{id}");
    sqlx::query("UPDATE burrow_tasks SET state='draft_ready',result='Original captured comparison' WHERE id=?").bind(id).execute(&s.state.db).await.unwrap();
    let r = patch(
        &s,
        &owner.token,
        &format!("{root}/result"),
        json!({"version":0,"result":"User edited comparison"}),
    )
    .await;
    assert_eq!(r.status(), 200);
    let edited: Value = r.json().await.unwrap();
    assert_eq!(edited["manual_edited"], true);
    assert_eq!(
        patch(
            &s,
            &owner.token,
            &format!("{root}/notes"),
            json!({"version":0,"text":"stale note"})
        )
        .await
        .status(),
        409
    );
    assert_eq!(
        patch(
            &s,
            &owner.token,
            &format!("{root}/notes"),
            json!({"version":1,"text":"Call supplier before purchase"})
        )
        .await
        .status(),
        200
    );
    // Proposed output is written by reconciliation, never accepted implicitly.
    sqlx::query("UPDATE burrow_tasks SET proposed_result='New sourced revision' WHERE id=?")
        .bind(id)
        .execute(&s.state.db)
        .await
        .unwrap();
    let other = s.register("editor_other", "test-password").await;
    for (token, version, expected) in [(&other.token, 2, 404), (&owner.token, 1, 409)] {
        assert_eq!(s.post_json_auth(&format!("{root}/keep-result"), token, json!({"version":version})).await.status(), expected);
    }
    let kept = s.post_json_auth(&format!("{root}/keep-result"), &owner.token, json!({"version":2})).await;
    assert_eq!(kept.status(), 200);
    let kept: Value = kept.json().await.unwrap();
    assert_eq!(kept["result"], "User edited comparison");
    assert_eq!(kept["proposed_result"], "");
    assert_eq!(kept["manual_edited"], true);
    assert_eq!(kept["manual_notes"], "Call supplier before purchase");
    assert_eq!(s.post_json_auth(&format!("{root}/keep-result"), &owner.token, json!({"version":2})).await.status(), 409);
    // A later proposal still requires a separate version-checked decision.
    sqlx::query("UPDATE burrow_tasks SET proposed_result='New sourced revision' WHERE id=?")
        .bind(id).execute(&s.state.db).await.unwrap();
    let r = s
        .post_json_auth(
            &format!("{root}/accept-revision"),
            &owner.token,
            json!({"version":3}),
        )
        .await;
    assert_eq!(r.status(), 200);
    let accepted: Value = r.json().await.unwrap();
    assert_eq!(accepted["result"], "New sourced revision");
    assert_eq!(accepted["manual_notes"], "Call supplier before purchase");
    assert_eq!(accepted["manual_edited"], false);
    let prior: Vec<String> = sqlx::query_scalar(
        "SELECT result FROM burrow_creation_history WHERE task_id=? ORDER BY id",
    )
    .bind(id)
    .fetch_all(&s.state.db)
    .await
    .unwrap();
    assert_eq!(
        prior,
        vec!["Original captured comparison", "User edited comparison"]
    );
}
