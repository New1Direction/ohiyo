//! Internal typed capabilities, not an agent loop or publicly mounted HTTP API.
//! The authenticated Pi bridge supplies Scope; model/tool arguments never create
//! mandates or traveler profiles. Research Materials are advisory inputs only.
pub mod duffel;
mod ledger;
pub use ledger::*;

use chrono::{DateTime, NaiveDate};
use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, TravelError>;

#[derive(Debug, thiserror::Error)]
pub enum TravelError {
    #[error("travel policy: {0}")]
    Policy(String),
    #[error("travel record not found in this scope")]
    NotFound,
    #[error("travel state conflict; read/reconcile the existing transaction")]
    Conflict,
    #[error("travel persistence: {0}")]
    Database(#[from] sqlx::Error),
    #[error("travel data: {0}")]
    Data(#[from] serde_json::Error),
    #[error("provider operation failed: {0}")]
    Provider(String),
    #[error("Duffel HTTP {status}: {message}; verify Stays enablement/account permissions")]
    ProviderResponse {
        status: u16,
        message: String,
        evidence: Box<Evidence>,
    },
}

pub(crate) fn require(ok: bool, reason: &str) -> Result<()> {
    if ok {
        Ok(())
    } else {
        Err(TravelError::Policy(reason.into()))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Scope {
    pub account_id: String,
    pub workspace_id: String,
    pub task_id: String,
    pub root_goal_id: String,
}

/// Exact minor units. Unsupported ISO exponents fail closed, never float/round FX.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Money {
    pub minor: i64,
    pub currency: String,
}
impl Money {
    pub fn parse(amount: &str, currency: &str) -> Result<Self> {
        let exponent = match currency {
            "CAD" | "USD" | "GBP" | "EUR" | "AUD" | "NZD" | "CHF" => 2,
            "JPY" => 0,
            "KWD" | "BHD" => 3,
            _ => {
                return Err(TravelError::Policy(format!(
                    "unsupported currency {currency}"
                )))
            }
        };
        let parts: Vec<_> = amount.split('.').collect();
        require(
            parts.len() <= 2
                && !parts[0].is_empty()
                && parts
                    .iter()
                    .all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit())),
            "invalid decimal amount",
        )?;
        let fraction = parts.get(1).copied().unwrap_or("");
        require(
            fraction.len() <= exponent,
            "amount precision exceeds currency exponent",
        )?;
        let digits = format!(
            "{}{}{}",
            parts[0],
            fraction,
            "0".repeat(exponent - fraction.len())
        );
        let minor = digits
            .parse::<i64>()
            .map_err(|_| TravelError::Policy("amount overflow".into()))?;
        Ok(Self {
            minor,
            currency: currency.into(),
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Guest {
    Adult,
    Child { age: u8 },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TravelerProfile {
    pub given_name: String,
    pub family_name: String,
    pub email: String,
    pub phone: String,
    pub born_on: NaiveDate,
}
impl TravelerProfile {
    fn validate(&self) -> Result<()> {
        require(
            !self.given_name.trim().is_empty() && !self.family_name.trim().is_empty(),
            "missing traveler given_name/family_name",
        )?;
        require(self.email.contains('@'), "missing/invalid traveler email")?;
        require(
            self.phone.starts_with('+')
                && (8..=16).contains(&self.phone.len())
                && self.phone[1..].bytes().all(|c| c.is_ascii_digit()),
            "missing/invalid traveler phone (E.164)",
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Mandate {
    pub maximum: Money,
    pub country_code: String,
    pub city: String,
    pub check_in: NaiveDate,
    pub check_out: NaiveDate,
    pub rooms: u8,
    pub guests: Vec<Guest>,
    pub require_refundable: bool,
    /// Explicit property allowlist. Empty means any property inside city/country.
    pub accommodation_ids: Vec<String>,
    /// No date/currency/guest substitutions in V1; optional property substitutions
    /// are confined to the allowlist or city. Preferences never grant authority.
    pub minimum_rating: Option<u8>,
    pub preferences: Vec<String>,
    pub spend_capability_id: String,
}
impl Mandate {
    fn validate(&self) -> Result<()> {
        require(
            self.maximum.minor > 0 && Money::parse("0", &self.maximum.currency).is_ok(),
            "invalid maximum",
        )?;
        require(
            self.check_out > self.check_in && (self.check_out - self.check_in).num_days() <= 99,
            "invalid dates",
        )?;
        require(
            self.rooms > 0
                && !self.guests.is_empty()
                && self
                    .guests
                    .iter()
                    .all(|g| !matches!(g, Guest::Child { age } if *age > 17)),
            "invalid rooms/guests",
        )?;
        require(
            !self.city.trim().is_empty()
                && self.country_code.len() == 2
                && !self.spend_capability_id.is_empty()
                && self.minimum_rating.is_none_or(|r| (1..=5).contains(&r)),
            "invalid location/rating/spend capability",
        )
    }

    /// Public filter for ranking; dispatch repeats this against the stored mandate.
    pub fn evaluate(&self, q: &Quote, now: i64) -> Result<()> {
        self.validate()?;
        require(
            q.valid_until > now && q.fetched_at <= now && now - q.fetched_at <= 120,
            "quote expired; obtain a fresh quote",
        )?;
        require(
            q.check_in == self.check_in
                && q.check_out == self.check_out
                && q.rooms == self.rooms
                && q.guests == self.guests,
            "dates/rooms/guests outside mandate",
        )?;
        require(
            q.accommodation.city.eq_ignore_ascii_case(&self.city)
                && q.accommodation.country_code == self.country_code,
            "destination outside mandate",
        )?;
        require(
            self.accommodation_ids.is_empty()
                || self.accommodation_ids.contains(&q.accommodation.id),
            "property substitution outside mandate",
        )?;
        require(
            self.minimum_rating
                .is_none_or(|min| q.accommodation.rating.is_some_and(|r| r >= min)),
            "rating missing/below mandate",
        )?;
        require(
            q.total.currency == self.maximum.currency
                && q.due_at_property.currency == self.maximum.currency
                && q.total.minor >= 0
                && q.due_at_property.minor >= 0,
            "currency mismatch; no FX authorization",
        )?;
        let total = q
            .total
            .minor
            .checked_add(q.due_at_property.minor)
            .ok_or_else(|| TravelError::Policy("amount overflow".into()))?;
        require(
            total <= self.maximum.minor,
            "quote plus mandatory property fees exceeds mandate",
        )?;
        require(
            q.payment_type == "pay_now" && q.balance_supported,
            "unsupported funding: V1 requires balance/pay_now",
        )?;
        require(
            !q.loyalty_required,
            "missing required loyalty_programme_account_number",
        )?;
        require(
            !self.require_refundable
                || q.cancellation
                    .iter()
                    .any(|c| c.before > now && c.refund == q.total),
            "full refundable policy not satisfied",
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Accommodation {
    pub id: String,
    pub name: String,
    pub city: String,
    pub country_code: String,
    pub address: String,
    pub latitude: f64,
    pub longitude: f64,
    pub rating: Option<u8>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Cancellation {
    pub before: i64,
    pub refund: Money,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Quote {
    pub id: String,
    pub rate_id: String,
    /// Duffel rooms have names, not stable room IDs; rate_id identifies inventory.
    pub room: String,
    pub accommodation: Accommodation,
    pub check_in: NaiveDate,
    pub check_out: NaiveDate,
    pub guests: Vec<Guest>,
    pub rooms: u8,
    pub total: Money,
    pub tax: Option<Money>,
    pub fee: Option<Money>,
    pub due_at_property: Money,
    pub cancellation: Vec<Cancellation>,
    pub conditions: Vec<String>,
    pub payment_type: String,
    pub balance_supported: bool,
    pub loyalty_required: bool,
    pub fetched_at: i64,
    pub valid_until: i64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GuestName {
    pub given_name: String,
    pub family_name: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Booking {
    pub id: String,
    pub reference: Option<String>,
    pub status: String,
    pub confirmed_at: Option<i64>,
    pub email: String,
    pub guests: Vec<GuestName>,
    pub transaction_id: Option<String>,
    pub request_id: Option<String>,
    pub quote: Quote,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SearchOption {
    pub search_result_id: String,
    pub accommodation: Accommodation,
    pub displayed_total: Money,
}
/// Adapter envelopes stay in scoped evidence, not tool/ranking contracts.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Evidence {
    pub status: u16,
    pub provider_request_id: Option<String>,
    pub correlation_id: Option<String>,
    pub body: serde_json::Value,
}
#[derive(Clone, Debug)]
pub struct Observed<T> {
    pub value: T,
    pub evidence: Evidence,
}

pub(crate) fn timestamp(s: &str) -> Result<i64> {
    DateTime::parse_from_rfc3339(s)
        .map(|t| t.timestamp())
        .map_err(|_| TravelError::Provider("invalid provider timestamp".into()))
}
