# Instant Servers — Phase 1 (Provision + Connect) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An authenticated Ohiyo user can call `POST /api/v1/instances` to provision their own community-server instance, and read its status back — with the whole control-plane orchestration built and tested against a fake provisioner, and a real Fly Machines provisioner wired behind the same trait.

**Architecture:** A new control-plane feature lives inside the existing axum server as an `instances` API module backed by a `hosted_instances` registry table (infra metadata only — never message data or E2E keys). Orchestration goes through a `MachineProvisioner` trait; `FakeProvisioner` makes the whole flow unit/integration-testable with zero infra, and `FlyProvisioner` is the real impl, selected at startup by the presence of `FLY_API_TOKEN`. The React client gets thin API bindings; the runtime "switch my app to the new server URL" UI is deferred (the client is locked to one compile-time `VITE_SERVER_URL`).

**Tech Stack:** Rust, axum, sqlx (SQLite), `async-trait`, `reqwest` (Fly Machines REST API), `uuid`, `chrono`. Client: TypeScript + Vite. Tests: the existing `tests/common` TestServer harness (real `build_app` over a file-backed temp SQLite).

---

## Naming & collision notes (read first)

- The codebase **already** has `Server`/`servers`/`server_members` (the community/guild entity). **Do NOT** reuse `server`/`Server`. The new entity is an **instance** (a provisioned Ohiyo backend): table `hosted_instances`, struct `HostedInstance`, routes `/api/v1/instances`, module `api/instances.rs`, orchestration crate-module `provision`.
- Established conventions to follow exactly: TEXT UUID primary keys (`crate::types::new_id()`), INTEGER unix timestamps (`crate::types::now_unix()`), INTEGER booleans, `sqlx::query`/`query_as` with `.bind()`, errors via `crate::api::error::internal`, handlers returning `Result<Json<T>, (StatusCode, String)>`, the `AuthUser` extractor as the first handler param.

## File structure

| File | New/Modify | Responsibility |
|---|---|---|
| `server/migrations/0027_hosted_instances.sql` | **Create** | Registry table (one row per provisioned instance) |
| `server/src/types.rs` | Modify | Add `HostedInstance` row struct |
| `server/src/provision/mod.rs` | **Create** | `MachineProvisioner` trait, provision DTOs/errors, `create_instance` orchestration |
| `server/src/provision/fake.rs` | **Create** | `FakeProvisioner` (deterministic, in-memory) |
| `server/src/provision/fly.rs` | **Create** | `FlyProvisioner` (real Fly Machines REST client) |
| `server/src/api/instances.rs` | **Create** | HTTP handlers: create / list / get |
| `server/src/api/mod.rs` | Modify | `mod instances;` + mount routes |
| `server/src/lib.rs` | Modify | `pub mod provision;`, add `provisioner` to `AppState`, select impl in `build_state` |
| `server/Cargo.toml` | Modify | Add `async-trait`; ensure `reqwest` has `json` feature |
| `server/tests/instances.rs` | **Create** | Integration tests against the fake provisioner |
| `client/src/api.ts` | Modify | `createInstance` / `listInstances` / `getInstance` bindings |

---

### Task 1: Registry migration

**Files:**
- Create: `server/migrations/0027_hosted_instances.sql`

- [ ] **Step 1: Confirm the next migration number**

Run: `ls server/migrations | sort | tail -3`
Expected: highest existing is `0026_device_link_tokens.sql`. If a higher number exists, use that number + 1 for the new file (and adjust all later references).

- [ ] **Step 2: Write the migration**

Create `server/migrations/0027_hosted_instances.sql`:

```sql
-- Control-plane registry for Instant Servers. Holds INFRA METADATA ONLY —
-- never message content or E2E keys. One row per provisioned Ohiyo instance.
CREATE TABLE IF NOT EXISTS hosted_instances (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    subdomain   TEXT NOT NULL UNIQUE,
    region      TEXT NOT NULL,
    tier        TEXT NOT NULL DEFAULT 'free' CHECK(tier IN ('free','paid')),
    status      TEXT NOT NULL CHECK(status IN ('requested','provisioning','healthy','failed')),
    machine_id  TEXT,
    volume_id   TEXT,
    public_url  TEXT,
    error       TEXT,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_hosted_instances_owner ON hosted_instances(owner_id);
```

- [ ] **Step 3: Verify it compiles + applies**

Run: `cd server && cargo build`
Expected: PASS. The `sqlx::migrate!("./migrations")` macro embeds the new file at compile time; a SQL syntax error would fail the build here.

- [ ] **Step 4: Commit**

```bash
git add server/migrations/0027_hosted_instances.sql
git commit -m "feat(instances): add hosted_instances registry table"
```

---

### Task 2: `HostedInstance` row struct

**Files:**
- Modify: `server/src/types.rs`

- [ ] **Step 1: Add the struct**

Append to `server/src/types.rs` (alongside the other `sqlx::FromRow` models):

```rust
/// A provisioned Instant-Server instance. Mirrors the `hosted_instances` table.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct HostedInstance {
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub subdomain: String,
    pub region: String,
    pub tier: String,
    pub status: String,
    pub machine_id: Option<String>,
    pub volume_id: Option<String>,
    pub public_url: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd server && cargo build`
Expected: PASS (an unused struct only warns; it is referenced in later tasks).

- [ ] **Step 3: Commit**

```bash
git add server/src/types.rs
git commit -m "feat(instances): add HostedInstance row struct"
```

---

### Task 3: Provisioner trait + DTOs + `FakeProvisioner` (TDD)

**Files:**
- Create: `server/src/provision/mod.rs`
- Create: `server/src/provision/fake.rs`
- Modify: `server/Cargo.toml`
- Modify: `server/src/lib.rs` (declare the module)

- [ ] **Step 1: Add the `async-trait` dependency**

In `server/Cargo.toml`, under `[dependencies]`, add (keep alphabetical if the file is ordered):

```toml
async-trait = "0.1"
```

- [ ] **Step 2: Write the trait, DTOs, and error type**

Create `server/src/provision/mod.rs`:

```rust
//! Control-plane provisioning. The `MachineProvisioner` trait is the seam between
//! orchestration logic and the underlying cloud (a fake for tests, Fly Machines for real).
//! This module holds INFRA concerns only — it never sees message plaintext or E2E keys.

pub mod fake;
pub mod fly;

use async_trait::async_trait;

/// What the control plane asks the cloud to stand up.
#[derive(Debug, Clone)]
pub struct ProvisionRequest {
    pub instance_id: String,
    pub subdomain: String,
    pub region: String,
    /// The public URL the new server will advertise (`PUBLIC_BASE_URL`).
    pub public_url: String,
    /// A unique per-instance JWT signing secret (>=32 chars).
    pub jwt_secret: String,
}

/// What the cloud hands back after a successful provision.
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProvisionError {
    Upstream(String),
    NotFound,
}

impl std::fmt::Display for ProvisionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProvisionError::Upstream(m) => write!(f, "provisioner upstream error: {m}"),
            ProvisionError::NotFound => write!(f, "machine not found"),
        }
    }
}
impl std::error::Error for ProvisionError {}

/// Abstracts the cloud that runs per-community instances.
#[async_trait]
pub trait MachineProvisioner: Send + Sync {
    async fn provision(&self, req: ProvisionRequest) -> Result<ProvisionedMachine, ProvisionError>;
    async fn status(&self, machine_id: &str) -> Result<MachineState, ProvisionError>;
    async fn destroy(&self, machine_id: &str) -> Result<(), ProvisionError>;
}
```

- [ ] **Step 3: Write the failing test for `FakeProvisioner`**

Create `server/src/provision/fake.rs`:

```rust
//! Deterministic in-memory provisioner. Used by tests and by local dev when no
//! `FLY_API_TOKEN` is present, so the whole flow is exercisable with zero infra.

use super::{MachineProvisioner, MachineState, ProvisionError, ProvisionRequest, ProvisionedMachine};
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct FakeProvisioner {
    machines: Mutex<HashMap<String, MachineState>>,
}

#[async_trait]
impl MachineProvisioner for FakeProvisioner {
    async fn provision(&self, req: ProvisionRequest) -> Result<ProvisionedMachine, ProvisionError> {
        let machine_id = format!("fake-machine-{}", req.instance_id);
        let volume_id = format!("fake-vol-{}", req.instance_id);
        self.machines
            .lock()
            .unwrap()
            .insert(machine_id.clone(), MachineState::Started);
        Ok(ProvisionedMachine {
            machine_id,
            volume_id,
            state: MachineState::Started,
        })
    }

    async fn status(&self, machine_id: &str) -> Result<MachineState, ProvisionError> {
        self.machines
            .lock()
            .unwrap()
            .get(machine_id)
            .copied()
            .ok_or(ProvisionError::NotFound)
    }

    async fn destroy(&self, machine_id: &str) -> Result<(), ProvisionError> {
        self.machines.lock().unwrap().remove(machine_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(id: &str) -> ProvisionRequest {
        ProvisionRequest {
            instance_id: id.into(),
            subdomain: "roost-ab12".into(),
            region: "iad".into(),
            public_url: "https://roost-ab12.ohiyo.gg".into(),
            jwt_secret: "x".repeat(32),
        }
    }

    #[tokio::test]
    async fn provision_then_status_then_destroy() {
        let p = FakeProvisioner::default();
        let m = p.provision(req("inst1")).await.unwrap();
        assert_eq!(m.machine_id, "fake-machine-inst1");
        assert_eq!(m.state, MachineState::Started);
        assert_eq!(p.status(&m.machine_id).await.unwrap(), MachineState::Started);
        p.destroy(&m.machine_id).await.unwrap();
        assert_eq!(p.status(&m.machine_id).await, Err(ProvisionError::NotFound));
    }
}
```

- [ ] **Step 4: Declare the module and a placeholder `fly` so it compiles**

In `server/src/lib.rs`, add near the other `mod` declarations:

```rust
pub mod provision;
```

Create a minimal `server/src/provision/fly.rs` so `pub mod fly;` resolves (filled in Task 8):

```rust
//! Real Fly Machines provisioner. Implemented in Task 8.
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && cargo test --lib provision::fake`
Expected: PASS — `provision_then_status_then_destroy ... ok`.

- [ ] **Step 6: Commit**

```bash
git add server/Cargo.toml server/src/provision/mod.rs server/src/provision/fake.rs server/src/lib.rs
git commit -m "feat(instances): MachineProvisioner trait + FakeProvisioner"
```

---

### Task 4: `create_instance` orchestration (TDD)

**Files:**
- Modify: `server/src/provision/mod.rs`

- [ ] **Step 1: Write the failing test**

Append to `server/src/provision/mod.rs`:

```rust
/// Max instances a single owner may hold on the free tier (cost-honest cap).
pub const MAX_FREE_INSTANCES: i64 = 3;

/// Slugify a display name and append a short unique suffix from the instance id.
fn make_subdomain(name: &str, id: &str) -> String {
    let mut slug: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    slug = slug.trim_matches('-').to_string();
    let slug: String = slug.split('-').filter(|s| !s.is_empty()).collect::<Vec<_>>().join("-");
    let slug = if slug.is_empty() { "server".to_string() } else { slug };
    let slug: String = slug.chars().take(24).collect();
    let suffix: String = id.chars().filter(|c| c.is_ascii_alphanumeric()).take(6).collect();
    format!("{slug}-{suffix}")
}

/// A unique >=32-char secret without pulling in a new RNG crate.
fn gen_jwt_secret() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// Provision a new instance for `owner_id`: validate, enforce the cap, write a
/// `provisioning` row, call the provisioner, then mark `healthy` or `failed`.
pub async fn create_instance(
    db: &sqlx::SqlitePool,
    provisioner: &dyn MachineProvisioner,
    owner_id: &str,
    name: &str,
) -> Result<crate::types::HostedInstance, (axum::http::StatusCode, String)> {
    use axum::http::StatusCode;
    use crate::types::{new_id, now_unix};

    let name = name.trim();
    if name.is_empty() || name.chars().count() > 64 {
        return Err((StatusCode::BAD_REQUEST, "name must be 1-64 characters".into()));
    }

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM hosted_instances WHERE owner_id = ?")
        .bind(owner_id)
        .fetch_one(db)
        .await
        .map_err(crate::api::error::internal)?;
    if count >= MAX_FREE_INSTANCES {
        return Err((StatusCode::CONFLICT, "free-tier instance limit reached".into()));
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
            sqlx::query("UPDATE hosted_instances SET status='failed', error=?, updated_at=? WHERE id=?")
                .bind(e.to_string())
                .bind(now_unix())
                .bind(&id)
                .execute(db)
                .await
                .map_err(crate::api::error::internal)?;
            return Err((StatusCode::BAD_GATEWAY, "provisioning failed".into()));
        }
    }

    let inst = sqlx::query_as::<_, crate::types::HostedInstance>(
        "SELECT * FROM hosted_instances WHERE id = ?",
    )
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

    async fn test_db() -> sqlx::SqlitePool {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query("INSERT INTO users (id, username, display_name, password_hash, created_at) VALUES ('u1','u','U','h',0)")
            .execute(&pool).await.unwrap();
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
        assert_eq!(inst.public_url.as_deref(), Some(format!("https://{}.ohiyo.gg", inst.subdomain).as_str()));
        assert!(inst.machine_id.unwrap().starts_with("fake-machine-"));
    }

    #[tokio::test]
    async fn rejects_blank_name() {
        let db = test_db().await;
        let p = FakeProvisioner::default();
        let err = create_instance(&db, &p, "u1", "   ").await.unwrap_err();
        assert_eq!(err.0, axum::http::StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn enforces_free_cap() {
        let db = test_db().await;
        let p = FakeProvisioner::default();
        for i in 0..MAX_FREE_INSTANCES {
            create_instance(&db, &p, "u1", &format!("s{i}")).await.unwrap();
        }
        let err = create_instance(&db, &p, "u1", "over").await.unwrap_err();
        assert_eq!(err.0, axum::http::StatusCode::CONFLICT);
    }
}
```

> Note: the unit test uses `sqlite::memory:` with a **single** pooled connection by default — fine here because `SqlitePool::connect` hands out one connection for an in-memory DB within the test. The integration tests (Task 7) use the real file-backed harness.

- [ ] **Step 2: Run the tests to verify they pass**

Run: `cd server && cargo test --lib provision::`
Expected: PASS — `creates_healthy_instance`, `rejects_blank_name`, `enforces_free_cap`, plus the Task 3 fake test, all `ok`.

- [ ] **Step 3: Commit**

```bash
git add server/src/provision/mod.rs
git commit -m "feat(instances): create_instance orchestration with cap + state transitions"
```

---

### Task 5: HTTP handlers + routes

**Files:**
- Create: `server/src/api/instances.rs`
- Modify: `server/src/api/mod.rs`

- [ ] **Step 1: Write the handlers**

Create `server/src/api/instances.rs`:

```rust
//! Instant Servers control-plane endpoints. Authenticated; owner-scoped.

use crate::auth::AuthUser;
use crate::types::HostedInstance;
use crate::{provision, AppState};
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;

#[derive(Deserialize)]
pub struct CreateInstanceBody {
    pub name: String,
}

/// POST /api/v1/instances — provision a new instance for the caller.
pub async fn create_instance(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<CreateInstanceBody>,
) -> Result<Json<HostedInstance>, (StatusCode, String)> {
    let inst =
        provision::create_instance(&state.db, state.provisioner.as_ref(), &auth.0, &body.name)
            .await?;
    Ok(Json(inst))
}

/// GET /api/v1/instances — list the caller's instances.
pub async fn list_instances(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<HostedInstance>>, (StatusCode, String)> {
    let rows = sqlx::query_as::<_, HostedInstance>(
        "SELECT * FROM hosted_instances WHERE owner_id = ? ORDER BY created_at DESC",
    )
    .bind(&auth.0)
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(Json(rows))
}

/// GET /api/v1/instances/{id} — status of one of the caller's instances.
pub async fn get_instance(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<HostedInstance>, (StatusCode, String)> {
    let inst = sqlx::query_as::<_, HostedInstance>(
        "SELECT * FROM hosted_instances WHERE id = ? AND owner_id = ?",
    )
    .bind(&id)
    .bind(&auth.0)
    .fetch_optional(&state.db)
    .await
    .map_err(crate::api::error::internal)?
    .ok_or((StatusCode::NOT_FOUND, "instance not found".to_string()))?;
    Ok(Json(inst))
}
```

- [ ] **Step 2: Mount the module and routes**

In `server/src/api/mod.rs`, add the module declaration with the others:

```rust
pub mod instances;
```

And inside `pub fn router() -> Router<AppState>` add these routes (next to the existing `.route("/servers", ...)` lines), using the existing `get`/`post` imports:

```rust
        .route(
            "/instances",
            get(instances::list_instances).post(instances::create_instance),
        )
        .route("/instances/{id}", get(instances::get_instance))
```

- [ ] **Step 3: Verify it compiles**

Run: `cd server && cargo build`
Expected: FAIL — `AppState` has no field `provisioner` yet (added in Task 6). This confirms the handler is correctly wired to the field we add next. If any *other* error appears (typo, missing import), fix it before continuing.

- [ ] **Step 4: Commit**

```bash
git add server/src/api/instances.rs server/src/api/mod.rs
git commit -m "feat(instances): create/list/get HTTP handlers + routes"
```

---

### Task 6: Wire the provisioner into `AppState` / `build_state`

**Files:**
- Modify: `server/src/lib.rs`

- [ ] **Step 1: Add the field to `AppState`**

In `server/src/lib.rs`, add to the `AppState` struct:

```rust
    pub provisioner: std::sync::Arc<dyn provision::MachineProvisioner>,
```

- [ ] **Step 2: Construct it in `build_state`**

Inside `pub fn build_state(db: SqlitePool) -> AppState`, before the `AppState { ... }` literal, add:

```rust
    let provisioner: std::sync::Arc<dyn provision::MachineProvisioner> =
        if std::env::var("FLY_API_TOKEN").is_ok() {
            std::sync::Arc::new(provision::fly::FlyProvisioner::from_env())
        } else {
            std::sync::Arc::new(provision::fake::FakeProvisioner::default())
        };
```

Then add `provisioner,` to the `AppState { ... }` initializer.

> `FlyProvisioner::from_env()` is defined in Task 8. Until then, keep a temporary stub so this compiles: add to `server/src/provision/fly.rs`:
> ```rust
> use super::{MachineProvisioner, MachineState, ProvisionError, ProvisionRequest, ProvisionedMachine};
> use async_trait::async_trait;
> pub struct FlyProvisioner;
> impl FlyProvisioner { pub fn from_env() -> Self { FlyProvisioner } }
> #[async_trait]
> impl MachineProvisioner for FlyProvisioner {
>     async fn provision(&self, _req: ProvisionRequest) -> Result<ProvisionedMachine, ProvisionError> {
>         Err(ProvisionError::Upstream("FlyProvisioner not implemented (Task 8)".into()))
>     }
>     async fn status(&self, _id: &str) -> Result<MachineState, ProvisionError> { Err(ProvisionError::NotFound) }
>     async fn destroy(&self, _id: &str) -> Result<(), ProvisionError> { Ok(()) }
> }
> ```

- [ ] **Step 3: Verify the whole server compiles**

Run: `cd server && cargo build`
Expected: PASS. Handlers from Task 5 now resolve `state.provisioner`.

- [ ] **Step 4: Commit**

```bash
git add server/src/lib.rs server/src/provision/fly.rs
git commit -m "feat(instances): select provisioner in build_state (Fly if FLY_API_TOKEN, else Fake)"
```

---

### Task 7: Integration tests (real harness, fake provisioner)

**Files:**
- Create: `server/tests/instances.rs`

- [ ] **Step 1: Write the failing tests**

Create `server/tests/instances.rs`:

```rust
mod common;

use common::TestServer;
use serde_json::{json, Value};

#[tokio::test]
async fn create_then_list_and_get_instance() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "supersecret123").await;

    let res = srv
        .post_json_auth("/api/v1/instances", &alice.token, json!({ "name": "The Roost" }))
        .await;
    assert_eq!(res.status(), 200, "create should succeed");
    let inst: Value = res.json().await.unwrap();
    assert_eq!(inst["status"], "healthy");
    assert_eq!(inst["tier"], "free");
    assert!(inst["public_url"].as_str().unwrap().ends_with(".ohiyo.gg"));
    assert!(inst["machine_id"].as_str().unwrap().starts_with("fake-machine-"));

    let id = inst["id"].as_str().unwrap().to_owned();

    let list: Value = srv.get_auth("/api/v1/instances", &alice.token).await.json().await.unwrap();
    assert_eq!(list.as_array().unwrap().len(), 1);

    let got = srv.get_auth(&format!("/api/v1/instances/{id}"), &alice.token).await;
    assert_eq!(got.status(), 200);
    let got_body: Value = got.json().await.unwrap();
    assert_eq!(got_body["id"], id);
}

#[tokio::test]
async fn instances_require_auth() {
    let srv = TestServer::start().await;
    let res = srv.post_json("/api/v1/instances", json!({ "name": "x" })).await;
    assert_eq!(res.status(), 401);
}

#[tokio::test]
async fn free_tier_cap_is_enforced() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "supersecret123").await;
    for i in 0..3 {
        let res = srv
            .post_json_auth("/api/v1/instances", &alice.token, json!({ "name": format!("s{i}") }))
            .await;
        assert_eq!(res.status(), 200, "instance {i} should provision");
    }
    let over = srv
        .post_json_auth("/api/v1/instances", &alice.token, json!({ "name": "over" }))
        .await;
    assert_eq!(over.status(), 409, "fourth instance should hit the free cap");
}

#[tokio::test]
async fn other_user_cannot_read_my_instance() {
    let srv = TestServer::start().await;
    let alice = srv.register("alice", "supersecret123").await;
    let bob = srv.register("bob", "supersecret123").await;

    let res = srv
        .post_json_auth("/api/v1/instances", &alice.token, json!({ "name": "Alice HQ" }))
        .await;
    let inst: Value = res.json().await.unwrap();
    let id = inst["id"].as_str().unwrap();

    let res = srv.get_auth(&format!("/api/v1/instances/{id}"), &bob.token).await;
    assert_eq!(res.status(), 404, "owner-scoping must hide other users' instances");
}
```

- [ ] **Step 2: Run the tests to verify they pass**

Run: `cd server && cargo test --test instances`
Expected: PASS — all four tests `ok`. (The harness sets no `FLY_API_TOKEN`, so `build_state` picks `FakeProvisioner`.)

- [ ] **Step 3: Run the full suite to confirm no regressions**

Run: `cd server && cargo test`
Expected: PASS — existing suites (security boundaries, signal identity, device link, etc.) plus the new `instances` tests all green.

- [ ] **Step 4: Commit**

```bash
git add server/tests/instances.rs
git commit -m "test(instances): integration coverage for provision/list/get/auth/cap"
```

---

### Task 8: Real `FlyProvisioner` (Fly Machines REST)

**Files:**
- Modify: `server/src/provision/fly.rs`
- Modify: `server/Cargo.toml` (ensure `reqwest` has the `json` feature)

> Live provisioning is **gated on you**: it needs `FLY_API_TOKEN`, `FLY_APP_NAME`, `FLY_IMAGE`, and the `ohiyo.gg` domain for real subdomains. This task builds the client and unit-tests the **request payload**; it does not make a live call.

- [ ] **Step 1: Ensure `reqwest` supports JSON**

In `server/Cargo.toml`, confirm `reqwest` is a (non-dev) dependency with `json`:

Run: `grep -n 'reqwest' server/Cargo.toml`
If it is only a `dev-dependency` or lacks `json`, add/extend under `[dependencies]`:

```toml
reqwest = { version = "0.12", default-features = false, features = ["json", "rustls-tls"] }
```

(Match the version already used elsewhere in the file if present.)

- [ ] **Step 2: Write the failing payload test**

Replace the contents of `server/src/provision/fly.rs` with:

```rust
//! Real Fly Machines provisioner. Launches one microVM per instance from the Ohiyo
//! server image, with a fresh volume and the per-instance env the server needs to boot.

use super::{MachineProvisioner, MachineState, ProvisionError, ProvisionRequest, ProvisionedMachine};
use async_trait::async_trait;
use serde_json::{json, Value};

pub struct FlyProvisioner {
    token: String,
    app: String,
    image: String,
    client: reqwest::Client,
}

impl FlyProvisioner {
    /// Build from env. Only called when `FLY_API_TOKEN` is present (see `build_state`).
    pub fn from_env() -> Self {
        FlyProvisioner {
            token: std::env::var("FLY_API_TOKEN").unwrap_or_default(),
            app: std::env::var("FLY_APP_NAME").unwrap_or_else(|_| "ohiyo-instances".into()),
            image: std::env::var("FLY_IMAGE").unwrap_or_else(|_| "registry.fly.io/ohiyo-instances:latest".into()),
            client: reqwest::Client::new(),
        }
    }

    /// The Fly Machines `POST /machines` body for one instance. Pure — unit-tested.
    fn machine_config(&self, req: &ProvisionRequest) -> Value {
        json!({
            "name": format!("ohiyo-{}", req.subdomain),
            "region": req.region,
            "config": {
                "image": self.image,
                "env": {
                    "JWT_SECRET": req.jwt_secret,
                    "PUBLIC_BASE_URL": req.public_url,
                    "DATABASE_URL": "sqlite:/data/kikkacord.db",
                    "BIND_ADDR": "0.0.0.0:3000"
                },
                "services": [{
                    "ports": [
                        { "port": 443, "handlers": ["tls", "http"] },
                        { "port": 80, "handlers": ["http"] }
                    ],
                    "protocol": "tcp",
                    "internal_port": 3000
                }],
                "mounts": [{ "volume": "", "path": "/data" }],
                "guest": { "cpu_kind": "shared", "cpus": 1, "memory_mb": 512 },
                "checks": {
                    "health": { "type": "http", "port": 3000, "method": "GET", "path": "/healthz", "interval": "15s", "timeout": "4s" }
                }
            }
        })
    }

    fn base(&self) -> String {
        format!("https://api.machines.dev/v1/apps/{}", self.app)
    }
}

#[async_trait]
impl MachineProvisioner for FlyProvisioner {
    async fn provision(&self, req: ProvisionRequest) -> Result<ProvisionedMachine, ProvisionError> {
        let body = self.machine_config(&req);
        let res = self
            .client
            .post(format!("{}/machines", self.base()))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .map_err(|e| ProvisionError::Upstream(e.to_string()))?;
        if !res.status().is_success() {
            return Err(ProvisionError::Upstream(format!("fly create returned {}", res.status())));
        }
        let v: Value = res.json().await.map_err(|e| ProvisionError::Upstream(e.to_string()))?;
        let machine_id = v["id"].as_str().unwrap_or_default().to_string();
        let volume_id = v["config"]["mounts"][0]["volume"].as_str().unwrap_or_default().to_string();
        Ok(ProvisionedMachine { machine_id, volume_id, state: MachineState::Starting })
    }

    async fn status(&self, machine_id: &str) -> Result<MachineState, ProvisionError> {
        let res = self
            .client
            .get(format!("{}/machines/{machine_id}", self.base()))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| ProvisionError::Upstream(e.to_string()))?;
        if res.status() == reqwest::StatusCode::NOT_FOUND {
            return Err(ProvisionError::NotFound);
        }
        let v: Value = res.json().await.map_err(|e| ProvisionError::Upstream(e.to_string()))?;
        Ok(match v["state"].as_str().unwrap_or("") {
            "started" => MachineState::Started,
            "stopped" => MachineState::Stopped,
            "starting" | "created" => MachineState::Starting,
            _ => MachineState::Failed,
        })
    }

    async fn destroy(&self, machine_id: &str) -> Result<(), ProvisionError> {
        self.client
            .delete(format!("{}/machines/{machine_id}?force=true", self.base()))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| ProvisionError::Upstream(e.to_string()))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req() -> ProvisionRequest {
        ProvisionRequest {
            instance_id: "inst1".into(),
            subdomain: "roost-ab12".into(),
            region: "iad".into(),
            public_url: "https://roost-ab12.ohiyo.gg".into(),
            jwt_secret: "s".repeat(32),
        }
    }

    #[test]
    fn machine_config_carries_required_env_and_mount() {
        let p = FlyProvisioner {
            token: "t".into(),
            app: "ohiyo-instances".into(),
            image: "registry.fly.io/ohiyo-instances:latest".into(),
            client: reqwest::Client::new(),
        };
        let cfg = p.machine_config(&req());
        assert_eq!(cfg["region"], "iad");
        assert_eq!(cfg["config"]["env"]["PUBLIC_BASE_URL"], "https://roost-ab12.ohiyo.gg");
        assert_eq!(cfg["config"]["env"]["JWT_SECRET"].as_str().unwrap().len(), 32);
        assert_eq!(cfg["config"]["env"]["DATABASE_URL"], "sqlite:/data/kikkacord.db");
        assert_eq!(cfg["config"]["mounts"][0]["path"], "/data");
        assert_eq!(cfg["config"]["checks"]["health"]["path"], "/healthz");
    }
}
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `cd server && cargo test --lib provision::fly`
Expected: PASS — `machine_config_carries_required_env_and_mount ... ok`.

- [ ] **Step 4: Confirm full build + clippy stay green**

Run: `cd server && cargo build && cargo clippy --all-targets --locked -- -D warnings`
Expected: PASS (CI uses the same clippy gate).

- [ ] **Step 5: Commit**

```bash
git add server/Cargo.toml server/src/provision/fly.rs
git commit -m "feat(instances): real Fly Machines provisioner (request-building unit-tested)"
```

---

### Task 9: Thin client API bindings (no UI switch yet)

**Files:**
- Modify: `client/src/api.ts`

> The client is locked to one compile-time `VITE_SERVER_URL`; calling these endpoints talks to the control-plane (the main app). The in-app "point my client at the new instance URL" switcher is **deferred to Phase 1b** (it needs `api.ts` `SERVER_ORIGIN` to become runtime-configurable — a separate refactor).

- [ ] **Step 1: Add the bindings**

In `client/src/api.ts`, add a typed interface and three functions that reuse the existing private `request<T>()` helper (it already attaches the Bearer token and JSON headers):

```ts
export interface HostedInstance {
  id: string;
  owner_id: string;
  name: string;
  subdomain: string;
  region: string;
  tier: string;
  status: "requested" | "provisioning" | "healthy" | "failed";
  machine_id: string | null;
  volume_id: string | null;
  public_url: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

/** Provision a new Instant-Server instance for the signed-in user. */
export function createInstance(name: string, token: string): Promise<HostedInstance> {
  return request<HostedInstance>("/instances", { method: "POST", body: JSON.stringify({ name }) }, token);
}

/** List the signed-in user's instances. */
export function listInstances(token: string): Promise<HostedInstance[]> {
  return request<HostedInstance[]>("/instances", { method: "GET" }, token);
}

/** Status of one instance the user owns. */
export function getInstance(id: string, token: string): Promise<HostedInstance> {
  return request<HostedInstance>(`/instances/${id}`, { method: "GET" }, token);
}
```

> Match the exact signature of the existing `request<T>(path, options, token)` helper in `api.ts`. If other API functions in this file follow a different calling convention (e.g. a shared `api` object), mirror that instead.

- [ ] **Step 2: Typecheck**

Run: `cd client && npm run typecheck` (or `npx tsc --noEmit` if no `typecheck` script)
Expected: PASS — no type errors.

- [ ] **Step 3: Commit**

```bash
git add client/src/api.ts
git commit -m "feat(instances): client API bindings for create/list/get instance"
```

---

## What Phase 1 deliberately does NOT do (deferred, honest)

- **In-app server switch** — pointing the running client at the newly provisioned `*.ohiyo.gg` URL (the client is locked to a compile-time `VITE_SERVER_URL`). This is a real `api.ts` refactor → Phase 1b.
- **Live provisioning** — needs `FLY_API_TOKEN` + `FLY_APP_NAME` + `FLY_IMAGE` and the `ohiyo.gg` domain. The `FlyProvisioner` is built and payload-tested; flipping it on is a config step on your side.
- **Sleep/wake, notification relay, export, graduate, billing** — Phases 2-5 in the spec.
- **Background reconciliation** — Phase 1 provisions synchronously and records `healthy`/`failed`. A poller that re-checks `provisioning` rows via `provisioner.status()` is a Phase 2 concern (pairs with sleep/wake).

## Going live later (your checklist, for reference)

1. Grab `ohiyo.gg`; add a wildcard `*.ohiyo.gg` record pointing at the Fly app.
2. Create the Fly app + push the server image: `fly apps create ohiyo-instances`; build/push `registry.fly.io/ohiyo-instances:latest` from `server/Dockerfile`.
3. On the control-plane host, set `FLY_API_TOKEN`, `FLY_APP_NAME=ohiyo-instances`, `FLY_IMAGE=registry.fly.io/ohiyo-instances:latest`. `build_state` auto-switches to `FlyProvisioner`.
4. Smoke-test `POST /api/v1/instances` and confirm a real machine boots and `/healthz` passes.

---

## Self-review

- **Spec coverage:** §6.1 control plane (registry + lifecycle create) → Tasks 1,2,4,5,6; §6.2 per-community instance via Fly Machines → Task 8; §7 "Create" data-flow → Tasks 4-7; §9 "infra metadata only, unique JWT_SECRET, correct PUBLIC_BASE_URL" → Tasks 1,4,8; §11 build-order Phase 1 (provision+connect) → this plan, with connect's client half explicitly deferred and reasoned. Sleep/wake, relay, export, graduate, billing correctly out of scope.
- **Type consistency:** `HostedInstance` fields match the migration columns 1:1; `MachineProvisioner`/`ProvisionRequest`/`ProvisionedMachine`/`MachineState`/`ProvisionError` used identically across `mod.rs`, `fake.rs`, `fly.rs`; `create_instance(db, provisioner, owner_id, name)` signature matches its call site in `api/instances.rs`; route paths (`/instances`, `/instances/{id}`) match the client bindings (`/instances`, `/instances/${id}`).
- **No placeholders:** every code step is complete; the only stub (Task 6 `fly.rs`) is explicitly temporary and fully replaced in Task 8.
