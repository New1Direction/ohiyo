//! Deterministic in-memory provisioner. Used by tests and by local dev when no
//! `FLY_API_TOKEN` is present, so the whole flow is exercisable with zero infra.

use super::{
    MachineProvisioner, MachineState, ProvisionError, ProvisionRequest, ProvisionedMachine,
};
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
        assert_eq!(
            p.status(&m.machine_id).await.unwrap(),
            MachineState::Started
        );
        p.destroy(&m.machine_id).await.unwrap();
        assert_eq!(p.status(&m.machine_id).await, Err(ProvisionError::NotFound));
    }
}
