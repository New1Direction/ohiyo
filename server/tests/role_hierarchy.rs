//! S-H2: unassigning and deleting roles must respect the role hierarchy, exactly as
//! assigning does. A moderator with Manage Roles can only touch roles ranked below
//! their own top role, and can only strip roles from members ranked below them.

mod common;

use common::{AuthOk, TestServer};
use serde_json::{json, Value};

const MANAGE_ROLES: i64 = 1 << 4;

async fn create_role(
    srv: &TestServer,
    token: &str,
    server_id: &str,
    name: &str,
    perms: i64,
) -> String {
    let role: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/roles"),
            token,
            json!({ "name": name, "permissions": perms }),
        )
        .await
        .json()
        .await
        .unwrap();
    role["id"].as_str().unwrap().to_owned()
}

async fn join(srv: &TestServer, code: &str, name: &str) -> AuthOk {
    let user = srv.register(name, "supersecret123").await;
    let res = srv
        .post_json_auth(&format!("/api/v1/invites/{code}"), &user.token, json!({}))
        .await;
    assert_eq!(res.status(), 200, "{name} joins by invite");
    user
}

async fn assign(srv: &TestServer, token: &str, server_id: &str, user_id: &str, role_id: &str) {
    let res = srv
        .put_json_auth(
            &format!("/api/v1/servers/{server_id}/members/{user_id}/roles/{role_id}"),
            token,
            json!({}),
        )
        .await;
    assert_eq!(res.status(), 204, "owner assigns role");
}

async fn unassign_status(
    srv: &TestServer,
    token: &str,
    server_id: &str,
    user_id: &str,
    role_id: &str,
) -> u16 {
    srv.delete_auth(
        &format!("/api/v1/servers/{server_id}/members/{user_id}/roles/{role_id}"),
        token,
    )
    .await
    .status()
    .as_u16()
}

async fn delete_status(srv: &TestServer, token: &str, server_id: &str, role_id: &str) -> u16 {
    srv.delete_auth(
        &format!("/api/v1/servers/{server_id}/roles/{role_id}"),
        token,
    )
    .await
    .status()
    .as_u16()
}

async fn member_roles(
    srv: &TestServer,
    token: &str,
    server_id: &str,
    user_id: &str,
) -> Vec<String> {
    let ids: Value = srv
        .get_auth(
            &format!("/api/v1/servers/{server_id}/members/{user_id}/roles"),
            token,
        )
        .await
        .json()
        .await
        .unwrap();
    ids.as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect()
}

async fn role_exists(srv: &TestServer, token: &str, server_id: &str, role_id: &str) -> bool {
    let roles: Value = srv
        .get_auth(&format!("/api/v1/servers/{server_id}/roles"), token)
        .await
        .json()
        .await
        .unwrap();
    roles.as_array().unwrap().iter().any(|r| r["id"] == role_id)
}

#[tokio::test]
async fn manage_roles_moderator_cannot_unassign_or_delete_higher_roles() {
    let srv = TestServer::start().await;
    let owner = srv.register("hierowner", "supersecret123").await;
    let server: Value = srv
        .post_json_auth("/api/v1/servers", &owner.token, json!({ "name": "Ranks" }))
        .await
        .json()
        .await
        .unwrap();
    let server_id = server["id"].as_str().unwrap().to_owned();
    let invite: Value = srv
        .post_json_auth(
            &format!("/api/v1/servers/{server_id}/invites"),
            &owner.token,
            json!({}),
        )
        .await
        .json()
        .await
        .unwrap();
    let code = invite["code"].as_str().unwrap().to_owned();

    let moderator = join(&srv, &code, "hiermod").await;
    let senior = join(&srv, &code, "hiersenior").await;
    let junior = join(&srv, &code, "hierjunior").await;

    // Creation order is rank order: Low < Mod < High.
    let low = create_role(&srv, &owner.token, &server_id, "Low", 0).await;
    let moder = create_role(&srv, &owner.token, &server_id, "Mod", MANAGE_ROLES).await;
    let high = create_role(&srv, &owner.token, &server_id, "High", 0).await;

    assign(&srv, &owner.token, &server_id, &moderator.id, &moder).await;
    assign(&srv, &owner.token, &server_id, &senior.id, &high).await;
    assign(&srv, &owner.token, &server_id, &senior.id, &low).await;
    assign(&srv, &owner.token, &server_id, &junior.id, &low).await;

    // Unassign: a role ranked above the moderator is off limits.
    assert_eq!(
        unassign_status(&srv, &moderator.token, &server_id, &senior.id, &high).await,
        403,
        "moderator must not strip a higher role"
    );
    // Unassign: even a lower role is off limits on a member who outranks the moderator.
    assert_eq!(
        unassign_status(&srv, &moderator.token, &server_id, &senior.id, &low).await,
        403,
        "moderator must not strip roles from a higher-ranked member"
    );
    let senior_roles = member_roles(&srv, &owner.token, &server_id, &senior.id).await;
    assert!(senior_roles.contains(&high) && senior_roles.contains(&low));

    // Unassign: a lower role from a lower-ranked member is fine.
    assert_eq!(
        unassign_status(&srv, &moderator.token, &server_id, &junior.id, &low).await,
        204
    );
    assert!(member_roles(&srv, &owner.token, &server_id, &junior.id)
        .await
        .is_empty());

    // Delete: higher and equal roles are off limits, lower ones are fine.
    assert_eq!(
        delete_status(&srv, &moderator.token, &server_id, &high).await,
        403,
        "moderator must not delete a higher role"
    );
    assert_eq!(
        delete_status(&srv, &moderator.token, &server_id, &moder).await,
        403,
        "moderator must not delete a role at their own rank"
    );
    assert!(role_exists(&srv, &owner.token, &server_id, &high).await);
    assert_eq!(
        delete_status(&srv, &moderator.token, &server_id, &low).await,
        204
    );
    assert!(!role_exists(&srv, &owner.token, &server_id, &low).await);

    // The owner outranks every role and member.
    assert_eq!(
        unassign_status(&srv, &owner.token, &server_id, &senior.id, &high).await,
        204
    );
    assert_eq!(
        delete_status(&srv, &owner.token, &server_id, &high).await,
        204
    );
}
