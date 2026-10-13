//! Stripe as the [`BillingProvider`]: Checkout for the subscription, the customer portal
//! for self-service, and signed webhooks for every change.
//!
//! Needs `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` and `STRIPE_PRICE_ID` (a recurring
//! monthly price). `STRIPE_API_BASE` exists only to point a test stack at a stand-in.

use super::{BillingError, BillingProvider, CheckoutRequest, CheckoutSession};
use async_trait::async_trait;
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;
use std::time::Duration;

type HmacSha256 = Hmac<Sha256>;

const STRIPE_API: &str = "https://api.stripe.com";
/// How old a signed webhook may be, as Stripe's own libraries allow.
const SIGNATURE_TOLERANCE_SECS: i64 = 300;

pub struct StripeBilling {
    secret_key: String,
    webhook_secret: String,
    price_id: String,
    base_url: String,
    client: reqwest::Client,
}

impl StripeBilling {
    pub fn new(
        secret_key: impl Into<String>,
        webhook_secret: impl Into<String>,
        price_id: impl Into<String>,
        base_url: impl Into<String>,
    ) -> Self {
        StripeBilling {
            secret_key: secret_key.into(),
            webhook_secret: webhook_secret.into(),
            price_id: price_id.into(),
            base_url: base_url.into().trim_end_matches('/').to_owned(),
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(20))
                .build()
                .unwrap_or_default(),
        }
    }

    /// `None` (paid plans off) unless all three settings are present.
    pub fn from_env() -> Option<Self> {
        let read = |name: &str| {
            std::env::var(name)
                .ok()
                .map(|v| v.trim().to_owned())
                .filter(|v| !v.is_empty())
        };
        let (key, webhook, price) = (
            read("STRIPE_SECRET_KEY"),
            read("STRIPE_WEBHOOK_SECRET"),
            read("STRIPE_PRICE_ID"),
        );
        match (key, webhook, price) {
            (Some(k), Some(w), Some(p)) => Some(StripeBilling::new(
                k,
                w,
                p,
                read("STRIPE_API_BASE").unwrap_or_else(|| STRIPE_API.to_owned()),
            )),
            (None, None, None) => None,
            _ => {
                tracing::warn!(
                    "Stripe is partly configured; set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and STRIPE_PRICE_ID. Paid plans stay off"
                );
                None
            }
        }
    }

    async fn post(
        &self,
        path: &str,
        form: &[(&str, &str)],
        idempotency_key: Option<&str>,
    ) -> Result<Value, BillingError> {
        let mut req = self
            .client
            .post(format!("{}{path}", self.base_url))
            .bearer_auth(&self.secret_key)
            .form(form);
        if let Some(key) = idempotency_key {
            req = req.header("Idempotency-Key", key);
        }
        Self::read(req.send().await).await
    }

    async fn read(res: reqwest::Result<reqwest::Response>) -> Result<Value, BillingError> {
        let res = res.map_err(|e| BillingError::Upstream(e.to_string()))?;
        let status = res.status();
        let body: Value = res.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(body);
        }
        if status == reqwest::StatusCode::NOT_FOUND
            || body["error"]["code"].as_str() == Some("resource_missing")
        {
            return Err(BillingError::NotFound);
        }
        Err(BillingError::Upstream(format!(
            "stripe returned {status}: {}",
            body["error"]["message"].as_str().unwrap_or("no message")
        )))
    }

    fn id_of(body: &Value) -> Result<String, BillingError> {
        body["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| BillingError::Upstream("stripe answered without an id".into()))
    }
}

#[async_trait]
impl BillingProvider for StripeBilling {
    async fn create_customer(&self, user_id: &str) -> Result<String, BillingError> {
        let body = self
            .post(
                "/v1/customers",
                &[("metadata[ohiyo_user_id]", user_id)],
                Some(&format!("ohiyo-customer-{user_id}")),
            )
            .await?;
        Self::id_of(&body)
    }

    async fn create_checkout(
        &self,
        req: &CheckoutRequest,
    ) -> Result<CheckoutSession, BillingError> {
        let body = self
            .post(
                "/v1/checkout/sessions",
                &[
                    ("mode", "subscription"),
                    ("customer", &req.customer_id),
                    ("client_reference_id", &req.instance_id),
                    ("line_items[0][price]", &self.price_id),
                    ("line_items[0][quantity]", "1"),
                    ("success_url", &req.success_url),
                    ("cancel_url", &req.cancel_url),
                    ("metadata[instance_id]", &req.instance_id),
                    ("metadata[owner_id]", &req.owner_id),
                    ("subscription_data[metadata][instance_id]", &req.instance_id),
                    ("subscription_data[metadata][owner_id]", &req.owner_id),
                ],
                None,
            )
            .await?;
        let url = body["url"]
            .as_str()
            .filter(|s| s.starts_with("https://") || s.starts_with("http://"))
            .ok_or_else(|| BillingError::Upstream("stripe checkout has no url".into()))?;
        Ok(CheckoutSession {
            id: Self::id_of(&body)?,
            url: url.to_owned(),
        })
    }

    async fn expire_checkout(&self, session_id: &str) -> Result<(), BillingError> {
        self.post(
            &format!("/v1/checkout/sessions/{session_id}/expire"),
            &[],
            None,
        )
        .await
        .map(|_| ())
    }

    async fn create_portal(
        &self,
        customer_id: &str,
        return_url: &str,
    ) -> Result<String, BillingError> {
        let body = self
            .post(
                "/v1/billing_portal/sessions",
                &[("customer", customer_id), ("return_url", return_url)],
                None,
            )
            .await?;
        body["url"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| BillingError::Upstream("stripe portal has no url".into()))
    }

    async fn cancel_at_period_end(&self, subscription_id: &str) -> Result<(), BillingError> {
        self.post(
            &format!("/v1/subscriptions/{subscription_id}"),
            &[("cancel_at_period_end", "true")],
            None,
        )
        .await
        .map(|_| ())
    }

    async fn cancel_now(&self, subscription_id: &str) -> Result<(), BillingError> {
        let res = self
            .client
            .delete(format!(
                "{}/v1/subscriptions/{subscription_id}",
                self.base_url
            ))
            .bearer_auth(&self.secret_key)
            .send()
            .await;
        Self::read(res).await.map(|_| ())
    }

    fn verify_webhook(
        &self,
        payload: &[u8],
        signature: &str,
        now: i64,
    ) -> Result<(), BillingError> {
        verify_signature(&self.webhook_secret, payload, signature, now)
    }
}

fn hex_decode(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

/// Check a `Stripe-Signature` header (`t=<unix>,v1=<hex hmac>,…`): the HMAC-SHA256 of
/// `"<t>.<body>"` under the endpoint secret, signed within the last five minutes.
pub fn verify_signature(
    secret: &str,
    payload: &[u8],
    header: &str,
    now: i64,
) -> Result<(), BillingError> {
    let mut timestamp: Option<&str> = None;
    let mut candidates = Vec::new();
    for part in header.split(',') {
        match part.trim().split_once('=') {
            Some(("t", v)) => timestamp = Some(v),
            Some(("v1", v)) => candidates.push(v),
            _ => {}
        }
    }
    let t = timestamp.ok_or(BillingError::BadSignature)?;
    let signed_at: i64 = t.parse().map_err(|_| BillingError::BadSignature)?;
    if (now - signed_at).abs() > SIGNATURE_TOLERANCE_SECS {
        return Err(BillingError::BadSignature);
    }
    for candidate in candidates {
        let Some(expected) = hex_decode(candidate) else {
            continue;
        };
        let mut mac =
            HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
        mac.update(t.as_bytes());
        mac.update(b".");
        mac.update(payload);
        if mac.verify_slice(&expected).is_ok() {
            return Ok(());
        }
    }
    Err(BillingError::BadSignature)
}

/// Sign a payload the way Stripe does. For tests and local stand-ins.
pub fn sign(secret: &str, payload: &[u8], t: i64) -> String {
    let mut mac =
        HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key length");
    mac.update(t.to_string().as_bytes());
    mac.update(b".");
    mac.update(payload);
    let hex: String = mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    format!("t={t},v1={hex}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_fresh_signature_from_the_secret() {
        let body = br#"{"id":"evt_1"}"#;
        let header = sign("whsec_test", body, 1_000);
        assert_eq!(verify_signature("whsec_test", body, &header, 1_100), Ok(()));
        // Stripe sends one v1 per active secret during a rotation; any match is enough.
        let rotated = format!("{},v1=00ff,v0=abc", header);
        assert_eq!(
            verify_signature("whsec_test", body, &rotated, 1_000),
            Ok(())
        );
    }

    #[test]
    fn refuses_a_wrong_secret_a_changed_body_or_an_old_signature() {
        let body = br#"{"id":"evt_1"}"#;
        let header = sign("whsec_test", body, 1_000);
        let bad = Err(BillingError::BadSignature);
        assert_eq!(verify_signature("whsec_other", body, &header, 1_000), bad);
        assert_eq!(
            verify_signature("whsec_test", br#"{"id":"evt_2"}"#, &header, 1_000),
            bad
        );
        assert_eq!(verify_signature("whsec_test", body, &header, 1_301), bad);
        assert_eq!(verify_signature("whsec_test", body, &header, 699), bad);
        assert_eq!(verify_signature("whsec_test", body, "v1=abcd", 1_000), bad);
        assert_eq!(verify_signature("whsec_test", body, "", 1_000), bad);
        assert_eq!(
            verify_signature("whsec_test", body, "t=1000,v1=zz", 1_000),
            bad
        );
    }
}
