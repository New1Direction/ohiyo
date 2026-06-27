//! Control-plane provisioning. The [`MachineProvisioner`] trait is the seam between
//! orchestration and the underlying cloud (a fake for tests, Fly Machines for real).
//! Infra concerns ONLY — this layer never sees message plaintext or E2E keys.

pub mod fake;
pub mod fly;

use crate::types::{new_id, now_unix, HostedInstance};
use async_trait::async_trait;
use axum::http::StatusCode;

/// What the control plane asks the cloud to stand up.
#[derive(Debug, Clone)]
pub struct ProvisionRequest {
    pub instance_id: String,
    pub subdomain: String,
    pub region: String,
    /// The public URL the new server will advertise (its `PUBLIC_BASE_URL`).
    pub public_url: String,
    /// A unique per-instance JWT signing secret (>=32 chars).
    pub jwt_secret: String,
}

/// What the cloud returns after a successful provision.
#[derive(Debug, Clone)]
pub struct ProvisionedMachine {
    pub machine_id: String,
    pub volume_id: String,
    pub state: MachineState,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MachineState {
    Starting,
    Started,
    Stopped,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProvisionError {
    #[error("provisioner upstream error: {0}")]
    Upstream(String),
    #[error("machine not found")]
    NotFound,
}

/// Abstracts the cloud that runs per-community instances.
#[async_trait]
pub trait MachineProvisioner: Send + Sync {
    async fn provision(&self, req: ProvisionRequest) -> Result<ProvisionedMachine, ProvisionError>;
    async fn status(&self, machine_id: &str) -> Result<MachineState, ProvisionError>;
    async fn destroy(&self, machine_id: &str) -> Result<(), ProvisionError>;
    async fn destroy_volume(&self, volume_id: &str) -> Result<(), ProvisionError>;
}

/// Max instances a single owner may hold on the free tier (cost-honest cap).
pub const MAX_FREE_INSTANCES: i64 = 3;

/// Slugify a display name and append a short unique suffix from the instance id, so
/// the subdomain is human-readable yet collision-resistant (`the-roost-a1b2c3`).
fn make_subdomain(name: &str, id: &str) -> String {
    let lowered: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    let slug = lowered
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    let slug = if slug.is_empty() {
        "server".to_string()
    } else {
        slug.chars().take(24).collect()
    };
    let suffix: String = id
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(6)
        .collect();
    format!("{slug}-{suffix}")
}

/// A unique >=32-char secret without pulling in a new RNG dependency (two v4 UUIDs
/// rendered as 32 hex chars each = 64 chars of entropy).
fn gen_jwt_secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Provision a new instance for `owner_id`: validate, enforce the free-tier cap, write a
/// `provisioning` row, call the provisioner, then mark the row `healthy` or `failed`.
pub async fn create_instance(
    db: &sqlx::SqlitePool,
    provisioner: &dyn MachineProvisioner,
    owner_id: &str,
    name: &str,
) -> Result<HostedInstance, (StatusCode, String)> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 64 {
        return Err((
            StatusCode::BAD_REQUEST,
            "name must be 1-64 characters".into(),
        ));
    }

    let id = new_id();
    let now = now_unix();
    let subdomain = make_subdomain(name, &id);
    let region = std::env::var("FLY_PRIMARY_REGION").unwrap_or_else(|_| "iad".into());
    let public_url = format!("https://{subdomain}.ohiyo.gg");

    // Atomic cap enforcement: the row is inserted only if the owner is under the
    // free-tier limit, evaluated in the same statement under SQLite's write lock. This
    // closes the check-then-insert TOCTOU (concurrent requests can't each read a stale
    // count and all insert) and excludes terminal-`failed` rows, so a run of provisioning
    // errors can't permanently lock a user out of their own quota.
    let inserted = sqlx::query(
        "INSERT INTO hosted_instances
         (id, owner_id, name, subdomain, region, tier, status, created_at, updated_at)
         SELECT ?,?,?,?,?,?,?,?,?
         WHERE (SELECT COUNT(*) FROM hosted_instances
                WHERE owner_id = ? AND status != 'failed') < ?",
    )
    .bind(&id)
    .bind(owner_id)
    .bind(name)
    .bind(&subdomain)
    .bind(&region)
    .bind("free")
    .bind("provisioning")
    .bind(now)
    .bind(now)
    .bind(owner_id)
    .bind(MAX_FREE_INSTANCES)
    .execute(db)
    .await
    .map_err(|e| {
        // A subdomain clash is a client-actionable conflict, not an internal error.
        if e.as_database_error()
            .map(|d| d.is_unique_violation())
            .unwrap_or(false)
        {
            (
                StatusCode::CONFLICT,
                "that name is taken — try another".into(),
            )
        } else {
            crate::api::error::internal(e)
        }
    })?;

    if inserted.rows_affected() == 0 {
        return Err((
            StatusCode::CONFLICT,
            "free-tier instance limit reached".into(),
        ));
    }

    let req = ProvisionRequest {
        instance_id: id.clone(),
        subdomain: subdomain.clone(),
        region,
        public_url: public_url.clone(),
        jwt_secret: gen_jwt_secret(),
    };

    match provisioner.provision(req).await {
        Ok(m) => {
            sqlx::query(
                "UPDATE hosted_instances
                 SET status='healthy', machine_id=?, volume_id=?, public_url=?, updated_at=?
                 WHERE id=?",
            )
            .bind(&m.machine_id)
            .bind(&m.volume_id)
            .bind(&public_url)
            .bind(now_unix())
            .bind(&id)
            .execute(db)
            .await
            .map_err(crate::api::error::internal)?;
        }
        Err(e) => {
            sqlx::query(
                "UPDATE hosted_instances SET status='failed', error=?, updated_at=? WHERE id=?",
            )
            .bind(e.to_string())
            .bind(now_unix())
            .bind(&id)
            .execute(db)
            .await
            .map_err(crate::api::error::internal)?;
            return Err((StatusCode::BAD_GATEWAY, "provisioning failed".into()));
        }
    }

    let inst = sqlx::query_as::<_, HostedInstance>("SELECT * FROM hosted_instances WHERE id = ?")
        .bind(&id)
        .fetch_one(db)
        .await
        .map_err(crate::api::error::internal)?;
    Ok(inst)
}

/// Destroy a caller-owned instance and its Fly volume, then remove the registry row. Cloud
/// `NotFound` is treated as success so cleanup is idempotent after partial failures.
pub async fn delete_instance(
    db: &sqlx::SqlitePool,
    provisioner: &dyn MachineProvisioner,
    owner_id: &str,
    id: &str,
) -> Result<(), (StatusCode, String)> {
    let inst = sqlx::query_as::<_, HostedInstance>(
        "SELECT * FROM hosted_instances WHERE id = ? AND owner_id = ?",
    )
    .bind(id)
    .bind(owner_id)
    .fetch_optional(db)
    .await
    .map_err(crate::api::error::internal)?
    .ok_or((StatusCode::NOT_FOUND, "instance not found".to_string()))?;

    if let Some(machine_id) = inst.machine_id.as_deref().filter(|s| !s.is_empty()) {
        match provisioner.destroy(machine_id).await {
            Ok(()) | Err(ProvisionError::NotFound) => {}
            Err(e) => return Err((StatusCode::BAD_GATEWAY, e.to_string())),
        }
    }

    if let Some(volume_id) = inst.volume_id.as_deref().filter(|s| !s.is_empty()) {
        match provisioner.destroy_volume(volume_id).await {
            Ok(()) | Err(ProvisionError::NotFound) => {}
            Err(e) => return Err((StatusCode::BAD_GATEWAY, e.to_string())),
        }
    }

    sqlx::query("DELETE FROM hosted_instances WHERE id = ? AND owner_id = ?")
        .bind(id)
        .bind(owner_id)
        .execute(db)
        .await
        .map_err(crate::api::error::internal)?;
    Ok(())
}

#[cfg(test)]
mod create_tests {
    use super::*;
    use crate::provision::fake::FakeProvisioner;
    use async_trait::async_trait;
    use sqlx::sqlite::SqlitePoolOptions;

    /// A provisioner that always fails — exercises the error branch of `create_instance`.
    struct FailingProvisioner;
    #[async_trait]
    impl MachineProvisioner for FailingProvisioner {
        async fn provision(
            &self,
            _req: ProvisionRequest,
        ) -> Result<ProvisionedMachine, ProvisionError> {
            Err(ProvisionError::Upstream("injected failure".into()))
        }
        async fn status(&self, _id: &str) -> Result<MachineState, ProvisionError> {
            Err(ProvisionError::NotFound)
        }
        async fn destroy(&self, _id: &str) -> Result<(), ProvisionError> {
            Ok(())
        }
        async fn destroy_volume(&self, _id: &str) -> Result<(), ProvisionError> {
            Ok(())
        }
    }

    /// A single-connection in-memory pool: a multi-connection `:memory:` pool would
    /// hand out separate empty databases, so the seeded user would vanish between queries.
    async fn test_db() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO users (id, username, display_name, password_hash, created_at)
             VALUES ('u1','u','U','h',0)",
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    #[tokio::test]
    async fn creates_healthy_instance() {
        let db = test_db().await;
        let p = FakeProvisioner::default();
        let inst = create_instance(&db, &p, "u1", "The Roost").await.unwrap();
        assert_eq!(inst.status, "healthy");
        assert_eq!(inst.tier, "free");
        assert!(inst.subdomain.starts_with("the-roost-"));
        assert_eq!(
            inst.public_url.as_deref(),
            Some(format!("https://{}.ohiyo.gg", inst.subdomain).as_str())
        );
        assert!(inst.machine_id.unwrap().starts_with("fake-machine-"));
    }

    #[tokio::test]
    async fn rejects_blank_name() {
        let db = test_db().await;
        let p = FakeProvisioner::default();
        let err = create_instance(&db, &p, "u1", "   ").await.unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn enforces_free_cap() {
        let db = test_db().await;
        let p = FakeProvisioner::default();
        for i in 0..MAX_FREE_INSTANCES {
            create_instance(&db, &p, "u1", &format!("s{i}"))
                .await
                .unwrap();
        }
        let err = create_instance(&db, &p, "u1", "over").await.unwrap_err();
        assert_eq!(err.0, StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn failed_provision_marks_row_and_returns_502() {
        let db = test_db().await;
        let err = create_instance(&db, &FailingProvisioner, "u1", "doomed")
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_GATEWAY);

        let (status, error): (String, Option<String>) =
            sqlx::query_as("SELECT status, error FROM hosted_instances WHERE owner_id = 'u1'")
                .fetch_one(&db)
                .await
                .unwrap();
        assert_eq!(status, "failed");
        assert!(error.is_some(), "the failure reason should be recorded");
    }

    #[tokio::test]
    async fn cap_excludes_failed_instances() {
        let db = test_db().await;
        // A failed attempt must NOT consume a cap slot.
        let _ = create_instance(&db, &FailingProvisioner, "u1", "doomed").await;
        let ok = FakeProvisioner::default();
        for i in 0..MAX_FREE_INSTANCES {
            create_instance(&db, &ok, "u1", &format!("s{i}"))
                .await
                .expect("healthy instances provision despite the earlier failed row");
        }
        // Now genuinely at the cap (3 healthy); the next is rejected.
        let err = create_instance(&db, &ok, "u1", "over").await.unwrap_err();
        assert_eq!(err.0, StatusCode::CONFLICT);
    }

    #[tokio::test]
    async fn delete_instance_removes_row_and_frees_fake_machine() {
        let db = test_db().await;
        let p = FakeProvisioner::default();
        let inst = create_instance(&db, &p, "u1", "temporary").await.unwrap();
        let machine_id = inst.machine_id.clone().unwrap();
        assert_eq!(p.status(&machine_id).await.unwrap(), MachineState::Started);

        delete_instance(&db, &p, "u1", &inst.id).await.unwrap();

        assert_eq!(p.status(&machine_id).await, Err(ProvisionError::NotFound));
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM hosted_instances WHERE id = ?")
            .bind(&inst.id)
            .fetch_one(&db)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }
}
