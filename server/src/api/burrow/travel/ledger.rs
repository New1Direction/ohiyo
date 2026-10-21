use super::{
    duffel::{BookingRequest, Stays, WriteOutcome},
    *,
};
use serde_json::{json, Value};
use sqlx::{Row, SqlitePool};

/// A spend authorization, not a charge instruction. V1's only funding adapter is
/// prefunded Duffel balance: the booking write itself consumes provider funds.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SpendRequest {
    pub purpose: String,
    pub amount: Money,
    pub capability: String,
    pub spend_capability_id: String,
    pub quote_id: String,
    pub mandate_id: String,
    pub mandate_version: i64,
    pub scope: Scope,
}

/// Side-effect-free authorization seam. A future MPP/Tempo funding dispatcher
/// must have its own durable outbox/uncertainty states, not send money here.
pub trait SpendBoundary: Send + Sync {
    fn authorize(&self, request: &SpendRequest) -> Result<()>;
}
pub struct PrefundedDuffelBalance {
    pub account_id: String,
    pub capability_id: String,
}
impl SpendBoundary for PrefundedDuffelBalance {
    fn authorize(&self, r: &SpendRequest) -> Result<()> {
        require(
            r.scope.account_id == self.account_id
                && r.spend_capability_id == self.capability_id
                && r.capability == "duffel_stays"
                && r.purpose == "hotel_booking",
            "funding adapter/account/capability mismatch",
        )
    }
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, sqlx::Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[sqlx(rename_all = "snake_case")]
pub enum TransactionState {
    Researching,
    Quoting,
    Quoted,
    BookingDispatched,
    BookingFailed,
    BookingUncertain,
    Reconciling,
    Completed,
    Stopped,
    UnresolvedNeedsAttention,
}
impl TransactionState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Researching => "researching",
            Self::Quoting => "quoting",
            Self::Quoted => "quoted",
            Self::BookingDispatched => "booking_dispatched",
            Self::BookingFailed => "booking_failed",
            Self::BookingUncertain => "booking_uncertain",
            Self::Reconciling => "reconciling",
            Self::Completed => "completed",
            Self::Stopped => "stopped",
            Self::UnresolvedNeedsAttention => "unresolved_needs_attention",
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BookingResult {
    pub transaction_id: String,
    pub scope: Scope,
    pub mandate_id: String,
    pub mandate_version: i64,
    pub booking: Booking,
    pub final_quote: Quote,
    pub research_price: Option<Money>,
    /// None for absent/different-currency research; never silently convert FX.
    pub research_to_quote_difference_minor: Option<i64>,
    pub selection_reason: String,
    pub funding_state: String,
    pub verified_at: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Transaction {
    pub id: String,
    pub scope: Scope,
    pub mandate_id: String,
    pub mandate_version: i64,
    pub state: TransactionState,
    pub stopped: bool,
    pub request_id: String,
    pub reconcile_started_at: Option<i64>,
    pub reconcile_attempts: i64,
    pub reconcile_next_at: Option<i64>,
    pub data: TransactionData,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TransactionData {
    pub travelers: Vec<TravelerProfile>,
    pub research_price: Option<Money>,
    pub selection_reason: String,
    pub quote_request_id: Option<String>,
    pub quote: Option<Quote>,
    pub booking_id: Option<String>,
    pub dispatched_at: Option<i64>,
    pub retry_allowed: bool,
    pub result: Option<BookingResult>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EvidenceRecord {
    pub operation: String,
    pub created_at: i64,
    pub body: Value,
}

#[derive(Clone)]
pub struct TravelLedger {
    db: SqlitePool,
}
impl TravelLedger {
    pub fn new(db: SqlitePool) -> Self {
        Self { db }
    }

    async fn scope(&self, s: &Scope) -> Result<()> {
        let ok: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM burrow_agent_runs r JOIN burrow_tasks t ON t.id=r.task_id JOIN burrow_computer_workspaces w ON w.id=r.computer_workspace WHERE t.user_id=? AND t.id=? AND r.root_goal=? AND w.id=? AND w.user_id=t.user_id)")
            .bind(&s.account_id).bind(&s.task_id).bind(&s.root_goal_id).bind(&s.workspace_id).fetch_one(&self.db).await?;
        if ok {
            Ok(())
        } else {
            Err(TravelError::NotFound)
        }
    }

    /// Trusted authenticated Burrow settings/admission only; NOT a model capability.
    /// Versions append; an executing transaction stays pinned to its original one.
    pub async fn record_mandate(
        &self,
        s: &Scope,
        id: &str,
        version: i64,
        m: &Mandate,
    ) -> Result<()> {
        self.scope(s).await?;
        m.validate()?;
        require(
            !id.is_empty() && version > 0,
            "invalid mandate identity/version",
        )?;
        let mut tx = self.db.begin_with("BEGIN IMMEDIATE").await?;
        let existing: Option<(String,String,String,i64)> = sqlx::query_as("SELECT user_id,task_id,root_goal_id,MAX(version) FROM burrow_travel_mandates WHERE id=? GROUP BY id").bind(id).fetch_optional(&mut *tx).await?;
        if let Some((owner, task, root, last)) = existing {
            require(
                owner == s.account_id
                    && task == s.task_id
                    && root == s.root_goal_id
                    && version == last + 1,
                "mandate owner/version conflict",
            )?;
        } else {
            require(version == 1, "first mandate version must be 1")?;
        }
        sqlx::query("INSERT INTO burrow_travel_mandates VALUES(?,?,?,?,?,?,?)")
            .bind(id)
            .bind(version)
            .bind(&s.account_id)
            .bind(&s.task_id)
            .bind(&s.root_goal_id)
            .bind(serde_json::to_string(m)?)
            .bind(crate::types::now_unix())
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(())
    }
    pub async fn mandate(&self, s: &Scope, id: &str, version: i64) -> Result<Mandate> {
        self.scope(s).await?;
        let body: String=sqlx::query_scalar("SELECT body FROM burrow_travel_mandates WHERE id=? AND version=? AND user_id=? AND task_id=? AND root_goal_id=?").bind(id).bind(version).bind(&s.account_id).bind(&s.task_id).bind(&s.root_goal_id).fetch_optional(&self.db).await?.ok_or(TravelError::NotFound)?;
        Ok(serde_json::from_str(&body)?)
    }
    /// Profiles are separate from conversation and immutable snapshots by ID.
    pub async fn record_profile(&self, account: &str, profile: &TravelerProfile) -> Result<String> {
        profile.validate()?;
        let id = uuid::Uuid::new_v4().to_string();
        sqlx::query("INSERT INTO burrow_travel_profiles VALUES(?,?,?)")
            .bind(&id)
            .bind(account)
            .bind(serde_json::to_string(profile)?)
            .execute(&self.db)
            .await?;
        Ok(id)
    }
    pub async fn begin(
        &self,
        s: &Scope,
        mandate_id: &str,
        version: i64,
        profile_ids: &[String],
        research_price: Option<Money>,
        selection_reason: String,
    ) -> Result<Transaction> {
        let mandate = self.mandate(s, mandate_id, version).await?;
        require(
            !selection_reason.trim().is_empty(),
            "selection reason required",
        )?;
        require(
            profile_ids.len() == mandate.guests.len(),
            "stored traveler profile required for every guest",
        )?;
        let mut travelers = Vec::new();
        for (id, guest) in profile_ids.iter().zip(&mandate.guests) {
            let body: String = sqlx::query_scalar(
                "SELECT body FROM burrow_travel_profiles WHERE id=? AND user_id=?",
            )
            .bind(id)
            .bind(&s.account_id)
            .fetch_optional(&self.db)
            .await?
            .ok_or(TravelError::NotFound)?;
            let t: TravelerProfile = serde_json::from_str(&body)?;
            t.validate()?;
            let age = chrono::Utc::now()
                .date_naive()
                .years_since(t.born_on)
                .ok_or_else(|| TravelError::Policy("traveler born_on is in the future".into()))?;
            require(
                match guest {
                    Guest::Adult => age >= 18,
                    Guest::Child { age: expected } => age == u32::from(*expected),
                },
                "traveler born_on does not match mandated guest type/age at booking",
            )?;
            travelers.push(t);
        }
        let id = uuid::Uuid::new_v4().to_string();
        let request = uuid::Uuid::new_v4().to_string();
        let now = crate::types::now_unix();
        let data = TransactionData {
            travelers,
            research_price,
            selection_reason,
            quote_request_id: None,
            quote: None,
            booking_id: None,
            dispatched_at: None,
            retry_allowed: false,
            result: None,
        };
        // UNIQUE root_goal_id prevents another action/request/mandate version from
        // bypassing an uncertain or already completed booking for the same goal.
        sqlx::query("INSERT INTO burrow_travel_transactions(id,user_id,task_id,workspace_id,root_goal_id,mandate_id,mandate_version,state,request_id,body,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'researching',?,?,?,?)")
            .bind(&id).bind(&s.account_id).bind(&s.task_id).bind(&s.workspace_id).bind(&s.root_goal_id).bind(mandate_id).bind(version).bind(request).bind(serde_json::to_string(&data)?).bind(now).bind(now).execute(&self.db).await?;
        self.get(s, &id).await
    }
    pub async fn get(&self, s: &Scope, id: &str) -> Result<Transaction> {
        self.scope(s).await?;
        let r=sqlx::query("SELECT * FROM burrow_travel_transactions WHERE id=? AND user_id=? AND task_id=? AND workspace_id=? AND root_goal_id=?").bind(id).bind(&s.account_id).bind(&s.task_id).bind(&s.workspace_id).bind(&s.root_goal_id).fetch_optional(&self.db).await?.ok_or(TravelError::NotFound)?;
        Ok(Transaction {
            id: id.into(),
            scope: s.clone(),
            mandate_id: r.get("mandate_id"),
            mandate_version: r.get("mandate_version"),
            state: r.try_get("state")?,
            stopped: r.get("stopped"),
            request_id: r.get("request_id"),
            reconcile_started_at: r.get("reconcile_started_at"),
            reconcile_attempts: r.get("reconcile_attempts"),
            reconcile_next_at: r.get("reconcile_next_at"),
            data: serde_json::from_str(r.get("body"))?,
        })
    }
    pub async fn evidence(&self, s: &Scope, id: &str) -> Result<Vec<EvidenceRecord>> {
        self.get(s, id).await?;
        let rows: Vec<(String,i64,String)> = sqlx::query_as(
            "SELECT operation,created_at,body FROM burrow_travel_evidence WHERE transaction_id=? ORDER BY seq",
        )
        .bind(id)
        .fetch_all(&self.db)
        .await?;
        rows.into_iter()
            .map(|(operation, created_at, body)| {
                Ok(EvidenceRecord {
                    operation,
                    created_at,
                    body: serde_json::from_str(&body)?,
                })
            })
            .collect()
    }
    async fn save_evidence(&self, id: &str, operation: &str, e: &impl Serialize) -> Result<()> {
        sqlx::query("INSERT INTO burrow_travel_evidence(transaction_id,operation,body,created_at) VALUES(?,?,?,?)").bind(id).bind(operation).bind(serde_json::to_string(e)?).bind(crate::types::now_unix()).execute(&self.db).await?;
        Ok(())
    }
    async fn save_error(&self, id: &str, operation: &str, e: &TravelError) -> Result<()> {
        let mut data = json!({"error":e.to_string()});
        if let TravelError::ProviderResponse { evidence, .. } = e {
            if operation != "reconcile_error" {
                data["evidence"] = serde_json::to_value(evidence)?;
            } else {
                data["provider_request_id"] = json!(evidence.provider_request_id);
            }
        }
        self.save_evidence(id, operation, &data).await
    }
    async fn active(&self, t: &Transaction) -> Result<()> {
        require(
            !t.stopped
                && (t.state != TransactionState::BookingFailed || t.data.retry_allowed)
                && matches!(
                    t.state.as_str(),
                    "researching" | "quoting" | "quoted" | "booking_failed"
                ),
            "transaction stopped or consequential outcome requires reconciliation",
        )?;
        let ok:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM burrow_agent_runs r WHERE r.root_goal=? AND r.phase='attached' AND NOT EXISTS(SELECT 1 FROM burrow_agent_commands c WHERE c.run_id=r.id AND c.action='stop' AND c.phase!='discarded'))").bind(&t.scope.root_goal_id).fetch_one(&self.db).await?;
        require(
            ok,
            "Pi run not attached or Stop requested; no new travel dispatch",
        )
    }
    pub async fn search(
        &self,
        s: &Scope,
        id: &str,
        p: &dyn Stays,
        lat: f64,
        lng: f64,
    ) -> Result<Vec<SearchOption>> {
        let t = self.get(s, id).await?;
        self.active(&t).await?;
        let m = self.mandate(s, &t.mandate_id, t.mandate_version).await?;
        let o = match p.search(&m, lat, lng).await {
            Ok(o) => o,
            Err(e) => {
                self.save_error(id, "search_error", &e).await?;
                return Err(e);
            }
        };
        self.save_evidence(id, "search", &o.evidence).await?;
        self.active(&self.get(s, id).await?).await?;
        Ok(o.value)
    }
    pub async fn rates(
        &self,
        s: &Scope,
        id: &str,
        p: &dyn Stays,
        result: &str,
    ) -> Result<Vec<Quote>> {
        let t = self.get(s, id).await?;
        self.active(&t).await?;
        let o = match p.rates(result).await {
            Ok(o) => o,
            Err(e) => {
                self.save_error(id, "rates_error", &e).await?;
                return Err(e);
            }
        };
        self.save_evidence(id, "rates", &o.evidence).await?;
        self.active(&self.get(s, id).await?).await?;
        let m = self.mandate(s, &t.mandate_id, t.mandate_version).await?;
        Ok(o.value
            .into_iter()
            .filter(|q| m.evaluate(q, crate::types::now_unix()).is_ok())
            .collect())
    }
    /// Advisory ranking rationale/price only; cannot change mandate or travelers.
    /// Call after research/ranking and before fresh quote, including on reselection.
    pub async fn record_selection(
        &self,
        s: &Scope,
        id: &str,
        reason: String,
        research_price: Option<Money>,
    ) -> Result<()> {
        let mut t = self.get(s, id).await?;
        self.active(&t).await?;
        require(!reason.trim().is_empty(), "selection reason required")?;
        let previous = serde_json::to_string(&t.data)?;
        t.data.selection_reason = reason;
        t.data.research_price = research_price;
        t.data.quote = None;
        let n=sqlx::query("UPDATE burrow_travel_transactions SET body=?,state='researching',updated_at=? WHERE id=? AND state=? AND body=? AND stopped=0").bind(serde_json::to_string(&t.data)?).bind(crate::types::now_unix()).bind(id).bind(t.state).bind(previous).execute(&self.db).await?.rows_affected();
        if n != 1 {
            return Err(TravelError::Conflict);
        };
        Ok(())
    }
    /// Fetches a fresh quote every time, even if a caller passes an old quote ID.
    /// Expired quotes are refreshed automatically by book() using the stored rate.
    pub async fn quote(&self, s: &Scope, id: &str, p: &dyn Stays, rate: &str) -> Result<Quote> {
        let t = self.get(s, id).await?;
        self.active(&t).await?;
        let mut data = t.data.clone();
        data.quote = None;
        data.quote_request_id = Some(uuid::Uuid::new_v4().to_string());
        let quote_fence = serde_json::to_string(&data)?;
        let changed=sqlx::query("UPDATE burrow_travel_transactions SET state='quoting',body=?,updated_at=? WHERE id=? AND state=? AND body=? AND stopped=0").bind(&quote_fence).bind(crate::types::now_unix()).bind(id).bind(t.state).bind(serde_json::to_string(&t.data)?).execute(&self.db).await?.rows_affected();
        if changed != 1 {
            return Err(TravelError::Conflict);
        }
        let o = p.quote(rate).await;
        match o {
            Err(e) => {
                self.save_error(id, "quote_error", &e).await?;
                Err(e)
            }
            Ok(o) => {
                self.save_evidence(id, "quote", &o.evidence).await?;
                self.active(&self.get(s, id).await?).await?;
                let m = self.mandate(s, &t.mandate_id, t.mandate_version).await?;
                m.evaluate(&o.value, crate::types::now_unix())?;
                data.quote = Some(o.value.clone());
                let n=sqlx::query("UPDATE burrow_travel_transactions SET state='quoted',body=?,updated_at=? WHERE id=? AND state='quoting' AND body=? AND stopped=0").bind(serde_json::to_string(&data)?).bind(crate::types::now_unix()).bind(id).bind(quote_fence).execute(&self.db).await?.rows_affected();
                if n != 1 {
                    return Err(TravelError::Conflict);
                };
                Ok(o.value)
            }
        }
    }

    /// Atomic spend reservation + dispatch fence. A crash after this commit, even
    /// before the socket write, is conservatively uncertain; never replay create.
    pub async fn book(
        &self,
        s: &Scope,
        id: &str,
        p: &dyn Stays,
        funding: &dyn SpendBoundary,
    ) -> Result<Transaction> {
        let mut t = self.get(s, id).await?;
        self.active(&t).await?;
        require(
            t.state == TransactionState::Quoted,
            "fresh accepted quote required before booking/retry",
        )?;
        let q = t
            .data
            .quote
            .as_ref()
            .ok_or_else(|| TravelError::Policy("fresh quote required".into()))?;
        if q.valid_until <= crate::types::now_unix()
            || crate::types::now_unix() - q.fetched_at > 120
        {
            let rate = q.rate_id.clone();
            self.quote(s, id, p, &rate).await?;
            t = self.get(s, id).await?;
        }
        let m = self.mandate(s, &t.mandate_id, t.mandate_version).await?;
        let q = t.data.quote.as_ref().unwrap();
        m.evaluate(q, crate::types::now_unix())?;
        let spend = SpendRequest {
            purpose: "hotel_booking".into(),
            amount: q.total.clone(),
            capability: "duffel_stays".into(),
            spend_capability_id: m.spend_capability_id.clone(),
            quote_id: q.id.clone(),
            mandate_id: t.mandate_id.clone(),
            mandate_version: t.mandate_version,
            scope: s.clone(),
        };
        funding.authorize(&spend)?;
        let previous_body = serde_json::to_string(&t.data)?;
        let now = crate::types::now_unix();
        t.data.dispatched_at = Some(now);
        let request = BookingRequest {
            transaction_id: id.into(),
            request_id: t.request_id.clone(),
            quote_id: q.id.clone(),
            travelers: t.data.travelers.clone(),
        };
        let mut tx = self.db.begin_with("BEGIN IMMEDIATE").await?;
        m.evaluate(t.data.quote.as_ref().unwrap(), crate::types::now_unix())?;
        // Check Stop in the same SQLite write transaction as the dispatch fence.
        let n=sqlx::query("UPDATE burrow_travel_transactions SET state='booking_dispatched',body=?,updated_at=? WHERE id=? AND state='quoted' AND body=? AND stopped=0 AND EXISTS(SELECT 1 FROM burrow_agent_runs r WHERE r.root_goal=burrow_travel_transactions.root_goal_id AND r.phase='attached' AND NOT EXISTS(SELECT 1 FROM burrow_agent_commands c WHERE c.run_id=r.id AND c.action='stop' AND c.phase!='discarded'))")
            .bind(serde_json::to_string(&t.data)?).bind(now).bind(id).bind(previous_body).execute(&mut *tx).await?.rows_affected();
        if n != 1 {
            return Err(TravelError::Conflict);
        }
        sqlx::query("INSERT INTO burrow_travel_spend VALUES(?,'hotel_booking',?,?,?,?,'reserved',?) ON CONFLICT(transaction_id) DO UPDATE SET capability=excluded.capability,quote_id=excluded.quote_id,amount_minor=excluded.amount_minor,currency=excluded.currency,state='reserved',updated_at=excluded.updated_at WHERE burrow_travel_spend.state='released'")
            .bind(id).bind(&spend.spend_capability_id).bind(&spend.quote_id).bind(spend.amount.minor).bind(&spend.amount.currency).bind(now).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO burrow_travel_evidence(transaction_id,operation,body,created_at) VALUES(?,'spend_authorized',?,?)").bind(id).bind(serde_json::to_string(&spend)?).bind(now).execute(&mut *tx).await?;
        tx.commit().await?;
        // Do not select! away this write on Stop. A lost future leaves the durable
        // dispatch fence in place for recovery/reconciliation.
        match p.create(&request).await {
            WriteOutcome::Confirmed(o) => {
                self.save_evidence(id, "booking_create", &o.evidence)
                    .await?;
                // Success is not completion: save the provider ID, then GET verify.
                t.data.booking_id = Some(o.value.id);
                sqlx::query("UPDATE burrow_travel_transactions SET body=?,state='booking_uncertain',updated_at=? WHERE id=? AND state IN ('booking_dispatched','booking_uncertain')")
                    .bind(serde_json::to_string(&t.data)?).bind(crate::types::now_unix()).bind(id).execute(&self.db).await?;
                self.reconcile(s, id, p).await
            }
            WriteOutcome::Rejected {
                evidence: e,
                retryable,
            } => {
                self.save_evidence(id, "booking_rejected", &e).await?;
                t.data.retry_allowed = retryable;
                let mut tx = self.db.begin_with("BEGIN IMMEDIATE").await?;
                let n=sqlx::query("UPDATE burrow_travel_transactions SET state='booking_failed',body=?,updated_at=? WHERE id=? AND state IN ('booking_dispatched','booking_uncertain')").bind(serde_json::to_string(&t.data)?).bind(crate::types::now_unix()).bind(id).execute(&mut *tx).await?.rows_affected();
                if n == 1 {
                    sqlx::query("UPDATE burrow_travel_spend SET state='released',updated_at=? WHERE transaction_id=?").bind(crate::types::now_unix()).bind(id).execute(&mut *tx).await?;
                }
                tx.commit().await?;
                self.get(s, id).await
            }
            WriteOutcome::Uncertain(e) => {
                self.save_evidence(id, "booking_uncertain", &e).await?;
                sqlx::query("UPDATE burrow_travel_transactions SET state='booking_uncertain',updated_at=? WHERE id=? AND state='booking_dispatched'").bind(crate::types::now_unix()).bind(id).execute(&self.db).await?;
                self.get(s, id).await
            }
        }
    }

    pub async fn stop(&self, s: &Scope, id: &str) -> Result<Transaction> {
        self.get(s, id).await?;
        sqlx::query("UPDATE burrow_travel_transactions SET stopped=1,state=CASE WHEN state IN ('researching','quoting','quoted','booking_failed') THEN 'stopped' WHEN state='booking_dispatched' THEN 'booking_uncertain' ELSE state END,updated_at=? WHERE id=?")
            .bind(crate::types::now_unix()).bind(id).execute(&self.db).await?;
        self.get(s, id).await
    }
    /// Trusted operator action, not automatic/model authority. Opens another
    /// bounded read-only reconciliation window on the SAME held transaction.
    /// It cannot reset Stop, release spending or authorize another create.
    pub async fn resume_reconciliation(
        &self,
        s: &Scope,
        id: &str,
        operator_note: &str,
    ) -> Result<Transaction> {
        let t = self.get(s, id).await?;
        require(
            t.state == TransactionState::UnresolvedNeedsAttention
                && !operator_note.trim().is_empty(),
            "unresolved transaction and operator evidence required",
        )?;
        let mut tx = self.db.begin_with("BEGIN IMMEDIATE").await?;
        let n=sqlx::query("UPDATE burrow_travel_transactions SET state='booking_uncertain',reconcile_started_at=NULL,reconcile_attempts=0,reconcile_next_at=NULL,updated_at=? WHERE id=? AND state='unresolved_needs_attention'").bind(crate::types::now_unix()).bind(id).execute(&mut *tx).await?.rows_affected();
        if n != 1 {
            return Err(TravelError::Conflict);
        }
        sqlx::query("INSERT INTO burrow_travel_evidence(transaction_id,operation,body,created_at) VALUES(?,'operator_reconciliation_resume',?,?)").bind(id).bind(json!({"note":operator_note,"previous_attempts":t.reconcile_attempts,"previous_start":t.reconcile_started_at}).to_string()).bind(crate::types::now_unix()).execute(&mut *tx).await?;
        tx.commit().await?;
        self.get(s, id).await
    }
    /// Called by Pi recovery or explicit reconciliation, never a background owner.
    /// Six attempts, >=30s apart, <=15min automatic window. Call after next_at.
    /// Deadline is evaluated even if the previous read crashed/timed out.
    pub async fn reconcile(&self, s: &Scope, id: &str, p: &dyn Stays) -> Result<Transaction> {
        let mut t = self.get(s, id).await?;
        require(
            matches!(
                t.state.as_str(),
                "booking_dispatched"
                    | "booking_uncertain"
                    | "reconciling"
                    | "unresolved_needs_attention"
            ),
            "transaction does not need reconciliation",
        )?;
        let now = crate::types::now_unix();
        let start = t.reconcile_started_at.unwrap_or(now);
        if t.reconcile_attempts >= 6 || now - start >= 900 {
            sqlx::query("UPDATE burrow_travel_transactions SET state='unresolved_needs_attention',updated_at=? WHERE id=? AND state!='completed'").bind(now).bind(id).execute(&self.db).await?;
            return self.get(s, id).await;
        }
        require(
            t.reconcile_next_at.is_none_or(|n| now >= n),
            "reconciliation backoff; no redispatch",
        )?;
        let n=sqlx::query("UPDATE burrow_travel_transactions SET state='reconciling',reconcile_started_at=COALESCE(reconcile_started_at,?),reconcile_attempts=reconcile_attempts+1,reconcile_next_at=?,updated_at=? WHERE id=? AND state=? AND reconcile_attempts=? AND (reconcile_next_at IS NULL OR reconcile_next_at<=?)")
            .bind(now).bind(now+30).bind(now).bind(id).bind(t.state).bind(t.reconcile_attempts).bind(now).execute(&self.db).await?.rows_affected();
        if n != 1 {
            return Err(TravelError::Conflict);
        }
        t.reconcile_started_at = Some(start);
        let mut candidates = Vec::new();
        let mut ambiguous = false;
        if let Some(bid) = &t.data.booking_id {
            match p.retrieve(bid).await {
                Ok(o) => {
                    self.save_evidence(id, "verify", &o.evidence).await?;
                    if o.value.id == *bid {
                        candidates.push(o.value)
                    } else {
                        ambiguous = true;
                    }
                }
                Err(e) => {
                    self.save_error(id, "verify_error", &e).await?;
                }
            }
        } else {
            let mut after = None;
            for page in 0..20 {
                match p.list(after.as_deref()).await {
                    Ok(o) => {
                        // Organization-wide list raw bodies may contain other Burrow
                        // accounts' PII. Persist only candidates for this fingerprint.
                        let matching: Vec<_> = o
                            .value
                            .bookings
                            .into_iter()
                            .filter(|b| fingerprint(&t, b))
                            .collect();
                        let owned: Vec<_> = matching
                            .iter()
                            .filter(|b| {
                                b.transaction_id.as_deref() == Some(id)
                                    && b.request_id.as_deref() == Some(&t.request_id)
                            })
                            .collect();
                        self.save_evidence(id,"reconcile_list",&json!({"provider_request_id":o.evidence.provider_request_id,"correlation_id":o.evidence.correlation_id,"status":o.evidence.status,"owned_candidates":owned,"similar_count":matching.len(),"after":o.value.after})).await?;
                        for b in matching {
                            if b.transaction_id.as_deref() == Some(id)
                                && b.request_id.as_deref() == Some(&t.request_id)
                            {
                                if !candidates.iter().any(|c: &Booking| c.id == b.id) {
                                    candidates.push(b);
                                }
                            } else {
                                ambiguous = true;
                            }
                        }
                        match o.value.after {
                            Some(next) if after.as_ref() != Some(&next) && page < 19 => {
                                after = Some(next)
                            }
                            Some(_) => {
                                ambiguous = true;
                                break;
                            }
                            None => break,
                        }
                    }
                    Err(e) => {
                        self.save_error(id, "reconcile_error", &e).await?;
                        // A later page may contain another reservation; a partial
                        // scan can never prove an unambiguous match.
                        candidates.clear();
                        break;
                    }
                }
            }
        }
        let valid = candidates.len() == 1
            && fingerprint(&t, &candidates[0])
            && candidates[0].status == "confirmed"
            && candidates[0].confirmed_at.is_some();
        if valid && !ambiguous {
            let b = candidates.remove(0);
            let q = t.data.quote.clone().ok_or(TravelError::Conflict)?;
            let difference = t
                .data
                .research_price
                .as_ref()
                .filter(|r| r.currency == q.total.currency)
                .and_then(|r| q.total.minor.checked_sub(r.minor));
            t.data.booking_id = Some(b.id.clone());
            t.data.result = Some(BookingResult {
                transaction_id: id.into(),
                scope: s.clone(),
                mandate_id: t.mandate_id.clone(),
                mandate_version: t.mandate_version,
                booking: b,
                final_quote: q,
                research_price: t.data.research_price.clone(),
                research_to_quote_difference_minor: difference,
                selection_reason: t.data.selection_reason.clone(),
                funding_state:
                    "duffel_balance_booking_confirmed_not_independent_settlement_receipt".into(),
                verified_at: now,
            });
            let mut tx = self.db.begin_with("BEGIN IMMEDIATE").await?;
            let n=sqlx::query("UPDATE burrow_travel_transactions SET state='completed',body=?,updated_at=? WHERE id=? AND state='reconciling' AND reconcile_attempts=?").bind(serde_json::to_string(&t.data)?).bind(now).bind(id).bind(t.reconcile_attempts+1).execute(&mut *tx).await?.rows_affected();
            if n != 1 {
                return Err(TravelError::Conflict);
            }
            sqlx::query("UPDATE burrow_travel_spend SET state='committed',updated_at=? WHERE transaction_id=?").bind(now).bind(id).execute(&mut *tx).await?;
            tx.commit().await?;
        } else {
            let state = if ambiguous || candidates.len() > 1 || t.reconcile_attempts + 1 >= 6 {
                "unresolved_needs_attention"
            } else {
                "booking_uncertain"
            };
            sqlx::query("UPDATE burrow_travel_transactions SET state=?,updated_at=? WHERE id=? AND state='reconciling' AND reconcile_attempts=?").bind(state).bind(now).bind(id).bind(t.reconcile_attempts+1).execute(&self.db).await?;
        }
        self.get(s, id).await
    }
}

fn fingerprint(t: &Transaction, b: &Booking) -> bool {
    let Some(q) = &t.data.quote else { return false };
    let Some(dispatched) = t.data.dispatched_at else {
        return false;
    };
    b.quote.accommodation.id == q.accommodation.id
        && b.quote.rate_id == q.rate_id
        && b.quote.room == q.room
        && b.quote.check_in == q.check_in
        && b.quote.check_out == q.check_out
        && b.quote.rooms == q.rooms
        && b.quote.guests == q.guests
        && b.quote.total == q.total
        && b.quote.due_at_property == q.due_at_property
        && b.quote.payment_type == q.payment_type
        && b.quote.balance_supported
        && b.quote.cancellation == q.cancellation
        && b.email == t.data.travelers[0].email
        && b.guests.len() == t.data.travelers.len()
        && b.guests
            .iter()
            .zip(&t.data.travelers)
            .all(|(a, b)| a.given_name == b.given_name && a.family_name == b.family_name)
        && b.confirmed_at.is_some_and(|at| {
            at >= dispatched - 60 && at <= t.reconcile_started_at.unwrap_or(dispatched) + 900
        })
}
