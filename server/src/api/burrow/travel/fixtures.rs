//! Explicit offline provider. No transport, credentials, computer or payment rail.
use super::{
    duffel::{BookingRequest, Stays, WriteOutcome},
    *,
};
use async_trait::async_trait;
use serde_json::json;
use sqlx::SqlitePool;

pub(super) struct FixtureStays {
    pub db: SqlitePool,
    pub scope: Scope,
    pub mandate: Mandate,
}

pub(super) fn hotels() -> Vec<Accommodation> {
    [
        (
            "fixture_cerulean",
            "Fictional Cerulean Stay",
            "26 Fixture Street",
            35.6563,
            139.6993,
            4,
        ),
        (
            "fixture_excel",
            "Fictional Shibuya Excel",
            "1 Fixture Square",
            35.6585,
            139.6997,
            4,
        ),
        (
            "fixture_stream",
            "Fictional Shibuya Stream",
            "3 Fixture Lane",
            35.6572,
            139.7020,
            3,
        ),
    ]
    .into_iter()
    .map(
        |(id, name, address, latitude, longitude, rating)| Accommodation {
            id: id.into(),
            name: name.into(),
            address: address.into(),
            latitude,
            longitude,
            city: "Tokyo".into(),
            country_code: "JP".into(),
            rating: Some(rating),
        },
    )
    .collect()
}

impl FixtureStays {
    async fn fault(&self) -> Result<String> {
        Ok(
            sqlx::query_scalar("SELECT fixture_fault FROM burrow_travel_requests WHERE task_id=?")
                .bind(&self.scope.task_id)
                .fetch_one(&self.db)
                .await?,
        )
    }
    fn rate(&self, id: &str, quoted: bool, high: bool) -> Result<Quote> {
        let index = ["rate_cerulean", "rate_excel", "rate_stream"]
            .iter()
            .position(|r| *r == id)
            .ok_or_else(|| TravelError::Provider("unknown fixture rate".into()))?;
        let now = crate::types::now_unix();
        let total = Money {
            minor: if high {
                999_999
            } else {
                [42000, 34000, 38000][index]
            },
            currency: "JPY".into(),
        };
        Ok(Quote {
            id: if quoted {
                format!("quote_{id}")
            } else {
                format!("search_{id}")
            },
            rate_id: id.into(),
            room: "Fixture double room".into(),
            bed_type: Some("double".into()),
            accommodation: hotels().remove(index),
            check_in: self.mandate.check_in,
            check_out: self.mandate.check_out,
            guests: self.mandate.guests.clone(),
            rooms: self.mandate.rooms,
            total: total.clone(),
            tax: None,
            fee: None,
            due_at_property: Money {
                minor: 1500,
                currency: "JPY".into(),
            },
            cancellation: vec![Cancellation {
                before: now + 86400,
                refund: total,
            }],
            conditions: vec!["Fictional inventory; no reservation or charge is made.".into()],
            payment_type: "pay_now".into(),
            balance_supported: true,
            loyalty_required: false,
            fetched_at: now,
            valid_until: now + 120,
        })
    }
    fn observed<T>(&self, value: T) -> Observed<T> {
        Observed {
            value,
            evidence: Evidence {
                status: 200,
                provider_request_id: Some("fixture-provider".into()),
                correlation_id: None,
                body: json!({"fixture":true}),
            },
        }
    }
}

#[async_trait]
impl Stays for FixtureStays {
    async fn search(
        &self,
        _m: &Mandate,
        _lat: f64,
        _lng: f64,
    ) -> Result<Observed<Vec<SearchOption>>> {
        let fault = self.fault().await?;
        if fault == "slow_search" {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        if fault == "search_failure" {
            return Err(TravelError::Provider(
                "Fixture inventory is unavailable.".into(),
            ));
        }
        Ok(self.observed(
            hotels()
                .into_iter()
                .enumerate()
                .map(|(i, accommodation)| SearchOption {
                    search_result_id: format!(
                        "search_{}",
                        ["rate_cerulean", "rate_excel", "rate_stream"][i]
                    ),
                    accommodation,
                    displayed_total: Money {
                        minor: [42000, 34000, 38000][i],
                        currency: "JPY".into(),
                    },
                })
                .collect(),
        ))
    }
    async fn rates(&self, result: &str) -> Result<Observed<Vec<Quote>>> {
        Ok(self.observed(vec![self.rate(
            result.strip_prefix("search_").unwrap_or(""),
            false,
            false,
        )?]))
    }
    async fn quote(&self, rate: &str) -> Result<Observed<Quote>> {
        let high = self.fault().await? == "quote_high";
        Ok(self.observed(self.rate(rate, true, high)?))
    }
    async fn create(&self, r: &BookingRequest) -> WriteOutcome {
        let result:Result<WriteOutcome>=async {
            let fault=self.fault().await?;
            if fault=="reject_once" {
                sqlx::query("UPDATE burrow_travel_requests SET fixture_fault='' WHERE task_id=?").bind(&self.scope.task_id).execute(&self.db).await?;
                let mut evidence=self.observed(()).evidence;
                evidence.status=503;
                evidence.body=json!({"fixture":true,"errors":[{"code":"service_unavailable","message":"No booking created"}]});
                return Ok(WriteOutcome::Rejected{evidence,retryable:true});
            }
            if fault=="lost_ack_absent" { return Ok(WriteOutcome::Uncertain(self.observed(()).evidence)); }
            // Use the exact accepted quote, including its cancellation deadline.
            let t=TravelLedger::new(self.db.clone()).get(&self.scope,&r.transaction_id).await?;
            let q=t.data.quote.ok_or(TravelError::Conflict)?;
            require(q.id==r.quote_id,"fixture quote identity changed")?;
            let b=Booking{id:format!("fixture_booking_{}",uuid::Uuid::new_v4()),reference:Some("NOT-A-REAL-BOOKING".into()),
                status:if fault=="never_confirm" {"pending"} else {"confirmed"}.into(), confirmed_at:Some(crate::types::now_unix()),
                email:r.travelers[0].email.clone(),guests:r.travelers.iter().map(|t| GuestName{given_name:t.given_name.clone(),family_name:t.family_name.clone()}).collect(),
                transaction_id:Some(r.transaction_id.clone()),request_id:Some(r.request_id.clone()),quote:q};
            sqlx::query("INSERT INTO burrow_travel_fixture_bookings VALUES(?,?,?)").bind(&b.id).bind(&self.scope.task_id).bind(serde_json::to_string(&b)?).execute(&self.db).await?;
            if fault=="lost_ack" { Ok(WriteOutcome::Uncertain(self.observed(()).evidence)) }
            else { Ok(WriteOutcome::Confirmed(self.observed(b))) }
        }.await;
        result.unwrap_or_else(|_| WriteOutcome::Uncertain(self.observed(()).evidence))
    }
    async fn retrieve(&self, id: &str) -> Result<Observed<Booking>> {
        let body: String = sqlx::query_scalar(
            "SELECT body FROM burrow_travel_fixture_bookings WHERE id=? AND task_id=?",
        )
        .bind(id)
        .bind(&self.scope.task_id)
        .fetch_optional(&self.db)
        .await?
        .ok_or(TravelError::NotFound)?;
        Ok(self.observed(serde_json::from_str(&body)?))
    }
    async fn list(&self, _after: Option<&str>) -> Result<Observed<duffel::BookingPage>> {
        let rows: Vec<String> =
            sqlx::query_scalar("SELECT body FROM burrow_travel_fixture_bookings WHERE task_id=?")
                .bind(&self.scope.task_id)
                .fetch_all(&self.db)
                .await?;
        Ok(self.observed(duffel::BookingPage {
            bookings: rows
                .into_iter()
                .map(|b| serde_json::from_str(&b))
                .collect::<std::result::Result<_, _>>()?,
            after: None,
        }))
    }
}
