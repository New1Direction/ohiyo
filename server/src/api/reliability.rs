//! Public reliability/status primitives and hosted-community cost model.
//! These endpoints expose operational health without leaking user content or secrets.

use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{types::now_unix, AppState};

#[derive(Debug, Serialize)]
pub struct ComponentStatus {
    pub name: &'static str,
    pub status: &'static str,
    pub detail: String,
}

#[derive(Debug, Serialize)]
pub struct StatusSummary {
    pub ok: bool,
    pub generated_at: i64,
    pub uptime_seconds: i64,
    pub components: Vec<ComponentStatus>,
}

#[derive(Debug, Deserialize)]
pub struct CostQuery {
    pub communities: Option<u32>,
    pub paid: Option<u32>,
    pub free_active_ratio: Option<f64>,
}

#[derive(Debug, Serialize)]
pub struct CostLine {
    pub label: &'static str,
    pub monthly_usd: f64,
    pub note: &'static str,
}

#[derive(Debug, Serialize)]
pub struct CostModel {
    pub communities: u32,
    pub paid: u32,
    pub free: u32,
    pub estimated_monthly_usd: f64,
    pub estimated_revenue_usd: f64,
    pub gross_margin_usd: f64,
    pub assumptions: Vec<CostLine>,
    pub note: &'static str,
}

fn round2(n: f64) -> f64 {
    (n * 100.0).round() / 100.0
}

/// GET /api/v1/reliability/status — public, content-free status summary.
pub async fn status_summary(
    State(state): State<AppState>,
) -> Result<Json<StatusSummary>, (StatusCode, String)> {
    let now = now_unix();
    let mut components = Vec::new();
    let mut ok = true;

    match sqlx::query("SELECT 1").execute(&state.db).await {
        Ok(_) => components.push(ComponentStatus {
            name: "database",
            status: "ok",
            detail: "SQLite query succeeded".into(),
        }),
        Err(e) => {
            ok = false;
            components.push(ComponentStatus {
                name: "database",
                status: "degraded",
                detail: format!("SQLite query failed: {e}"),
            });
        }
    }

    let (connected_users, gateway_connections) = {
        let sessions = state.sessions.read().unwrap_or_else(|e| e.into_inner());
        let connected_users = sessions.len();
        let gateway_connections: usize = sessions.values().map(|m| m.len()).sum();
        (connected_users, gateway_connections)
    };
    components.push(ComponentStatus {
        name: "gateway",
        status: "ok",
        detail: format!(
            "{connected_users} connected users / {gateway_connections} websocket connections"
        ),
    });

    let voice_rooms = { state.voice.read().unwrap_or_else(|e| e.into_inner()).len() };
    components.push(ComponentStatus {
        name: "voice",
        status: "ok",
        detail: format!("{voice_rooms} active voice rooms"),
    });

    let hosted: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM hosted_instances WHERE status != 'failed'")
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);
    components.push(ComponentStatus {
        name: "instant_servers",
        status: "ok",
        detail: format!("{hosted} managed instances registered"),
    });

    let push_queued: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM push_deliveries WHERE status = 'queued'")
            .fetch_one(&state.db)
            .await
            .unwrap_or(0);
    components.push(ComponentStatus {
        name: "push_relay",
        status: "ok",
        detail: format!("{push_queued} content-free push deliveries queued"),
    });

    Ok(Json(StatusSummary {
        ok,
        generated_at: now,
        uptime_seconds: now.saturating_sub(state.started_at),
        components,
    }))
}

/// GET /api/v1/reliability/cost-model — rough per-community hosting model.
pub async fn cost_model(Query(q): Query<CostQuery>) -> Json<CostModel> {
    let communities = q.communities.unwrap_or(100).max(1);
    let paid = q.paid.unwrap_or(10).min(communities);
    let free = communities - paid;
    let free_active_ratio = q.free_active_ratio.unwrap_or(0.15).clamp(0.0, 1.0);

    // Conservative public assumptions. Tune from invoices, but keep the model honest and
    // easy to inspect: free servers sleep, paid servers stay warm, shared control plane is
    // amortized, and storage/backup costs scale with all communities.
    let control_plane = 12.0;
    let relay = 5.0;
    let paid_instance = 3.80;
    let free_instance_effective = 0.65 * free_active_ratio;
    let storage_backup = 0.18;
    let observability = 0.08;
    let revenue_per_paid = 8.0;

    let costs = vec![
        CostLine {
            label: "shared control plane",
            monthly_usd: control_plane,
            note: "single always-on API/gateway machine baseline",
        },
        CostLine {
            label: "shared push/status relay",
            monthly_usd: relay,
            note: "content-free push/status/ops baseline",
        },
        CostLine {
            label: "paid always-on instances",
            monthly_usd: paid as f64 * paid_instance,
            note: "per paid hosted community",
        },
        CostLine {
            label: "free sleeping instances",
            monthly_usd: free as f64 * free_instance_effective,
            note: "effective cost after sleep/wake duty cycle",
        },
        CostLine {
            label: "storage + backups",
            monthly_usd: communities as f64 * storage_backup,
            note: "SQLite volume/snapshots/object backup allowance",
        },
        CostLine {
            label: "observability + alerts",
            monthly_usd: communities as f64 * observability,
            note: "logs, status checks, alerting overhead",
        },
    ];
    let total: f64 = costs.iter().map(|c| c.monthly_usd).sum();
    let revenue = paid as f64 * revenue_per_paid;

    Json(CostModel {
        communities,
        paid,
        free,
        estimated_monthly_usd: round2(total),
        estimated_revenue_usd: round2(revenue),
        gross_margin_usd: round2(revenue - total),
        assumptions: costs.into_iter().map(|mut c| { c.monthly_usd = round2(c.monthly_usd); c }).collect(),
        note: "Planning model, not an invoice. Replace assumptions with real Fly/Cloudflare/storage bills as usage grows.",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cost_model_rounding_is_stable() {
        assert_eq!(round2(1.234), 1.23);
        assert_eq!(round2(1.235), 1.24);
    }
}
