//! Real Fly Machines provisioner. For each instance it creates a persistent volume,
//! then launches one microVM from the Ohiyo server image mounting that volume at /data.
//!
//! Live provisioning needs `FLY_API_TOKEN`, `FLY_APP_NAME`, and `FLY_IMAGE`. The
//! request-payload builder is unit-tested; the network calls are not exercised in CI.

use super::{
    MachineProvisioner, MachineState, ProvisionError, ProvisionRequest, ProvisionedMachine,
};
use async_trait::async_trait;
use serde_json::{json, Value};

/// Persistent volume size (GiB) for an instance's SQLite DB + uploads. Matches `fly.toml`.
const VOLUME_SIZE_GB: u32 = 3;

pub struct FlyProvisioner {
    token: String,
    app: String,
    image: String,
    client: reqwest::Client,
}

impl FlyProvisioner {
    /// Build from env. Only constructed when `FLY_API_TOKEN` is present (see `build_state`).
    pub fn from_env() -> Self {
        FlyProvisioner {
            token: std::env::var("FLY_API_TOKEN").unwrap_or_default(),
            app: std::env::var("FLY_APP_NAME").unwrap_or_else(|_| "ohiyo-instances".into()),
            image: std::env::var("FLY_IMAGE")
                .unwrap_or_else(|_| "registry.fly.io/ohiyo-instances:latest".into()),
            client: reqwest::Client::new(),
        }
    }

    fn base(&self) -> String {
        format!("https://api.machines.dev/v1/apps/{}", self.app)
    }

    /// Create a persistent volume for this instance and return its id. A machine without
    /// a volume mounts /data as ephemeral tmpfs — the SQLite DB would be wiped on every
    /// restart — so this MUST succeed before the machine is created.
    async fn create_volume(&self, region: &str) -> Result<String, ProvisionError> {
        let body = json!({ "name": "ohiyo_data", "region": region, "size_gb": VOLUME_SIZE_GB });
        let res = self
            .client
            .post(format!("{}/volumes", self.base()))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .map_err(|e| ProvisionError::Upstream(e.to_string()))?;
        if !res.status().is_success() {
            return Err(ProvisionError::Upstream(format!(
                "fly volume create returned {}",
                res.status()
            )));
        }
        let v: Value = res
            .json()
            .await
            .map_err(|e| ProvisionError::Upstream(e.to_string()))?;
        Ok(v["id"].as_str().unwrap_or_default().to_string())
    }

    /// The Fly Machines `POST /machines` body for one instance. Pure — unit-tested.
    fn machine_config(&self, req: &ProvisionRequest, volume_id: &str) -> Value {
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
                "mounts": [{ "volume": volume_id, "path": "/data" }],
                "guest": { "cpu_kind": "shared", "cpus": 1, "memory_mb": 512 },
                "checks": {
                    "health": {
                        "type": "http", "port": 3000, "method": "GET",
                        "path": "/healthz", "interval": "15s", "timeout": "4s"
                    }
                }
            }
        })
    }
}

#[async_trait]
impl MachineProvisioner for FlyProvisioner {
    async fn provision(&self, req: ProvisionRequest) -> Result<ProvisionedMachine, ProvisionError> {
        let volume_id = self.create_volume(&req.region).await?;
        let body = self.machine_config(&req, &volume_id);
        let res = self
            .client
            .post(format!("{}/machines", self.base()))
            .bearer_auth(&self.token)
            .json(&body)
            .send()
            .await
            .map_err(|e| ProvisionError::Upstream(e.to_string()))?;
        if !res.status().is_success() {
            return Err(ProvisionError::Upstream(format!(
                "fly create returned {}",
                res.status()
            )));
        }
        let v: Value = res
            .json()
            .await
            .map_err(|e| ProvisionError::Upstream(e.to_string()))?;
        let machine_id = v["id"].as_str().unwrap_or_default().to_string();
        Ok(ProvisionedMachine {
            machine_id,
            volume_id,
            state: MachineState::Starting,
        })
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
        if !res.status().is_success() {
            return Err(ProvisionError::Upstream(format!(
                "fly status returned {}",
                res.status()
            )));
        }
        let v: Value = res
            .json()
            .await
            .map_err(|e| ProvisionError::Upstream(e.to_string()))?;
        Ok(match v["state"].as_str().unwrap_or("") {
            "started" => MachineState::Started,
            "stopped" => MachineState::Stopped,
            "starting" | "created" => MachineState::Starting,
            _ => MachineState::Failed,
        })
    }

    async fn destroy(&self, machine_id: &str) -> Result<(), ProvisionError> {
        let res = self
            .client
            .delete(format!("{}/machines/{machine_id}?force=true", self.base()))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| ProvisionError::Upstream(e.to_string()))?;
        if !res.status().is_success() {
            return Err(ProvisionError::Upstream(format!(
                "fly delete returned {}",
                res.status()
            )));
        }
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
    fn machine_config_carries_required_env_and_real_volume() {
        let p = FlyProvisioner {
            token: "t".into(),
            app: "ohiyo-instances".into(),
            image: "registry.fly.io/ohiyo-instances:latest".into(),
            client: reqwest::Client::new(),
        };
        let cfg = p.machine_config(&req(), "vol_abc123");
        assert_eq!(cfg["region"], "iad");
        assert_eq!(
            cfg["config"]["env"]["PUBLIC_BASE_URL"],
            "https://roost-ab12.ohiyo.gg"
        );
        assert_eq!(
            cfg["config"]["env"]["JWT_SECRET"].as_str().unwrap().len(),
            32
        );
        assert_eq!(
            cfg["config"]["env"]["DATABASE_URL"],
            "sqlite:/data/kikkacord.db"
        );
        assert_eq!(cfg["config"]["mounts"][0]["path"], "/data");
        // Regression guard: the mount must reference a real volume id, never "".
        assert_eq!(cfg["config"]["mounts"][0]["volume"], "vol_abc123");
        assert!(!cfg["config"]["mounts"][0]["volume"]
            .as_str()
            .unwrap()
            .is_empty());
        assert_eq!(cfg["config"]["checks"]["health"]["path"], "/healthz");
    }
}
