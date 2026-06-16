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

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM hosted_instances WHERE owner_id = ?")
        .bind(owner_id)
        .fetch_one(db)
        .await
        .map_err(crate::api::error::internal)?;
    if count >= MAX_FREE_INSTANCES {
        return Err((
            StatusCode::CONFLICT,
            "free-tier instance limit reached".into(),
        ));
    }

    let id = new_id();
    let now = now_unix();
    let subdomain = make_subdomain(name, &id);
    let region = std::env::var("FLY_PRIMARY_REGION").unwrap_or_else(|_| "iad".into());
    let public_url = format!("https://{subdomain}.ohiyo.gg");

    sqlx::query(
        "INSERT INTO hosted_instances
         (id, owner_id, name, subdomain, region, tier, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)",
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
    .execute(db)
    .await
    .map_err(crate::api::error::internal)?;

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

#[cfg(test)]
mod create_tests {
    use super::*;
    use crate::provision::fake::FakeProvisioner;
    use sqlx::sqlite::SqlitePoolOptions;

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
}
