//! Duffel v2 Stays wire shapes terminate here. No browser/payment-card fallback.
use super::*;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::time::Duration;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BookingRequest {
    pub transaction_id: String,
    pub request_id: String,
    pub quote_id: String,
    pub travelers: Vec<TravelerProfile>,
}

#[derive(Clone, Debug)]
pub enum WriteOutcome {
    Confirmed(Observed<Booking>),
    /// Documented rejection or 503 (Duffel explicitly guarantees no booking).
    Rejected {
        evidence: Evidence,
        retryable: bool,
    },
    /// Includes transport loss, 202, 500/502/504 and malformed success bodies.
    Uncertain(Evidence),
}

#[derive(Clone, Debug)]
pub struct BookingPage {
    pub bookings: Vec<Booking>,
    pub after: Option<String>,
}

#[async_trait]
pub trait Stays: Send + Sync {
    async fn search(
        &self,
        mandate: &Mandate,
        latitude: f64,
        longitude: f64,
    ) -> Result<Observed<Vec<SearchOption>>>;
    async fn rates(&self, search_result_id: &str) -> Result<Observed<Vec<Quote>>>;
    async fn quote(&self, rate_id: &str) -> Result<Observed<Quote>>;
    async fn create(&self, request: &BookingRequest) -> WriteOutcome;
    async fn retrieve(&self, booking_id: &str) -> Result<Observed<Booking>>;
    async fn list(&self, after: Option<&str>) -> Result<Observed<BookingPage>>;
}

/// Injectable typed HTTP seam. Tests need no token and never call Duffel.
#[async_trait]
pub trait Http: Send + Sync {
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        correlation_id: &str,
    ) -> Result<Evidence>;
}

pub struct Duffel<H: Http> {
    http: H,
}
impl<H: Http> Duffel<H> {
    pub fn new(http: H) -> Self {
        Self { http }
    }
    async fn read(&self, method: &str, path: &str, body: Option<Value>) -> Result<Evidence> {
        let e = self
            .http
            .request(method, path, body, &uuid::Uuid::new_v4().to_string())
            .await?;
        if !(200..300).contains(&e.status) {
            let codes: Vec<_> = e.body["errors"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|e| e["code"].as_str())
                .collect();
            return Err(TravelError::ProviderResponse {
                status: e.status,
                message: format!(
                    "provider error codes [{}]; request {:?}",
                    codes.join(", "),
                    e.provider_request_id
                ),
                evidence: Box::new(e),
            });
        }
        Ok(e)
    }
}

pub struct DuffelHttp {
    client: reqwest::Client,
    token: String,
}
impl DuffelHttp {
    /// Explicit host configuration only. Merely setting a token enables no routes.
    pub fn new(token: String) -> Result<Self> {
        require(!token.trim().is_empty(), "missing Duffel access token")?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(Duration::from_secs(45))
            .build()
            .map_err(|_| TravelError::Provider("HTTP client initialization".into()))?;
        Ok(Self { client, token })
    }
}
#[async_trait]
impl Http for DuffelHttp {
    async fn request(
        &self,
        method: &str,
        path: &str,
        body: Option<Value>,
        correlation_id: &str,
    ) -> Result<Evidence> {
        let mut req = self
            .client
            .request(
                method
                    .parse()
                    .map_err(|_| TravelError::Provider("invalid HTTP method".into()))?,
                format!("https://api.duffel.com/stays/{path}"),
            )
            .bearer_auth(&self.token)
            .header("Duffel-Version", "v2")
            .header("Accept", "application/json")
            .header("x-client-correlation-id", correlation_id);
        if let Some(body) = body {
            req = req.json(&json!({"data":body}));
        }
        // Do not retry, including inside this transport. Error text never logs a token.
        let response = req
            .send()
            .await
            .map_err(|_| TravelError::Provider("transport outcome unknown".into()))?;
        let status = response.status().as_u16();
        let header = |name| {
            response
                .headers()
                .get(name)
                .and_then(|h| h.to_str().ok())
                .map(str::to_owned)
        };
        let provider_request_id = header("x-request-id");
        let correlation_id = header("x-client-correlation-id");
        let body = match response.text().await {
            Ok(text) => serde_json::from_str(&text).unwrap_or(json!({"unparsed_body":text})),
            Err(_) => json!({"unreadable_body":true}),
        };
        Ok(Evidence {
            status,
            provider_request_id,
            correlation_id,
            body,
        })
    }
}

fn id(id: &str) -> String {
    urlencoding::encode(id).into_owned()
}
fn observed<T>(e: Evidence, parse: impl FnOnce(&Value) -> Result<T>) -> Result<Observed<T>> {
    match parse(&e.body["data"]) {
        Ok(value) => Ok(Observed { value, evidence: e }),
        Err(error) => Err(TravelError::ProviderResponse {
            status: e.status,
            message: error.to_string(),
            evidence: Box::new(e),
        }),
    }
}
fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| TravelError::Provider(format!("missing {key}")))
}
fn money(v: &Value, name: &str) -> Result<Money> {
    Money::parse(
        field(v, &format!("{name}_amount"))?,
        field(v, &format!("{name}_currency"))?,
    )
}
fn optional_money(v: &Value, name: &str) -> Result<Option<Money>> {
    if v[format!("{name}_amount")].is_null() {
        Ok(None)
    } else {
        money(v, name).map(Some)
    }
}
fn accommodation(v: &Value) -> Result<Accommodation> {
    let a = &v["location"]["address"];
    Ok(Accommodation {
        id: field(v, "id")?.into(),
        name: field(v, "name")?.into(),
        city: field(a, "city_name")?.into(),
        country_code: field(a, "country_code")?.into(),
        address: field(a, "line_one")?.into(),
        latitude: v["location"]["geographic_coordinates"]["latitude"]
            .as_f64()
            .ok_or_else(|| TravelError::Provider("missing latitude".into()))?,
        longitude: v["location"]["geographic_coordinates"]["longitude"]
            .as_f64()
            .ok_or_else(|| TravelError::Provider("missing longitude".into()))?,
        rating: v["rating"].as_u64().and_then(|r| u8::try_from(r).ok()),
    })
}
fn date(v: &Value, key: &str) -> Result<NaiveDate> {
    field(v, key)?
        .parse()
        .map_err(|_| TravelError::Provider(format!("invalid {key}")))
}
fn count(v: &Value, key: &str) -> Result<u8> {
    v[key]
        .as_u64()
        .and_then(|n| u8::try_from(n).ok())
        .filter(|n| *n > 0)
        .ok_or_else(|| TravelError::Provider(format!("invalid {key}")))
}
fn guest_types(v: &Value) -> Result<Vec<Guest>> {
    let list = v
        .as_array()
        .ok_or_else(|| TravelError::Provider("missing guest types".into()))?;
    list.iter()
        .map(|g| match field(g, "type")? {
            "adult" => Ok(Guest::Adult),
            "child" => Ok(Guest::Child {
                age: g["age"]
                    .as_u64()
                    .filter(|n| *n <= 17)
                    .ok_or_else(|| TravelError::Provider("missing child age".into()))?
                    as u8,
            }),
            _ => Err(TravelError::Provider("unknown guest type".into())),
        })
        .collect()
}

fn normalize(v: &Value, rate_id: Option<&str>, booking: bool) -> Result<Quote> {
    let rooms = v["accommodation"]["rooms"]
        .as_array()
        .ok_or_else(|| TravelError::Provider("missing rooms".into()))?;
    let pairs: Vec<_> = rooms
        .iter()
        .flat_map(|room| {
            room["rates"]
                .as_array()
                .into_iter()
                .flatten()
                .map(move |rate| (room, rate))
        })
        .filter(|(_, r)| rate_id.is_none_or(|rid| r["id"] == rid))
        .collect();
    require(
        pairs.len() == 1,
        "provider inventory ambiguous/unavailable; expected one selected rate",
    )?;
    let (room, rate) = pairs[0];
    let source = if booking || v["total_amount"].is_null() {
        rate
    } else {
        v
    };
    let now = crate::types::now_unix();
    let total = money(source, "total")?;
    // Null means unknown, NOT zero. Unknown/cross-currency property liabilities fail
    // closed at normalization/policy rather than silently exceeding a total mandate.
    let due_at_property = money(source, "due_at_accommodation")?;
    let cancellation = rate["cancellation_timeline"]
        .as_array()
        .ok_or_else(|| TravelError::Provider("missing cancellation timeline".into()))?
        .iter()
        .map(|c| {
            Ok(Cancellation {
                before: timestamp(field(c, "before")?)?,
                refund: Money::parse(field(c, "refund_amount")?, field(c, "currency")?)?,
            })
        })
        .collect::<Result<_>>()?;
    let methods = rate["available_payment_methods"]
        .as_array()
        .ok_or_else(|| TravelError::Provider("missing available_payment_methods".into()))?;
    // Published schema is string[]; published examples currently contain string[][].
    let balance_supported = methods.iter().any(|m| {
        m == "balance"
            || m.as_array()
                .is_some_and(|a| a.iter().any(|s| s == "balance"))
    });
    Ok(Quote {
        id: field(v, "id")?.into(),
        rate_id: field(rate, "id")?.into(),
        room: field(room, "name")?.into(),
        accommodation: accommodation(&v["accommodation"])?,
        check_in: date(v, "check_in_date")?,
        check_out: date(v, "check_out_date")?,
        rooms: count(v, "rooms")?,
        guests: guest_types(&v[if booking { "guest_types" } else { "guests" }])?,
        total,
        tax: optional_money(source, "tax")?,
        fee: optional_money(source, "fee")?,
        due_at_property,
        cancellation,
        conditions: rate["conditions"]
            .as_array()
            .ok_or_else(|| TravelError::Provider("missing rate conditions".into()))?
            .iter()
            .map(|c| field(c, "description").map(str::to_owned))
            .collect::<Result<_>>()?,
        payment_type: field(rate, "payment_type")?.into(),
        balance_supported,
        loyalty_required: rate["loyalty_programme_required"]
            .as_bool()
            .ok_or_else(|| TravelError::Provider("missing loyalty_programme_required".into()))?,
        fetched_at: now,
        valid_until: timestamp(field(rate, "expires_at")?)?.min(now + 120),
    })
}
fn booking(v: &Value) -> Result<Booking> {
    Ok(Booking {
        id: field(v, "id")?.into(),
        reference: v["reference"].as_str().map(str::to_owned),
        status: field(v, "status")?.into(),
        confirmed_at: v["confirmed_at"].as_str().map(timestamp).transpose()?,
        email: field(v, "email")?.into(),
        guests: serde_json::from_value(v["guests"].clone())?,
        transaction_id: v["metadata"]["burrow_transaction_id"]
            .as_str()
            .map(str::to_owned),
        request_id: v["metadata"]["burrow_request_id"]
            .as_str()
            .map(str::to_owned),
        quote: normalize(v, None, true)?,
    })
}

#[async_trait]
impl<H: Http> Stays for Duffel<H> {
    async fn search(
        &self,
        m: &Mandate,
        latitude: f64,
        longitude: f64,
    ) -> Result<Observed<Vec<SearchOption>>> {
        m.validate()?;
        require(
            latitude.is_finite()
                && longitude.is_finite()
                && latitude.abs() <= 90.
                && longitude.abs() <= 180.,
            "invalid search coordinates",
        )?;
        let mut body = json!({"check_in_date":m.check_in,"check_out_date":m.check_out,"rooms":m.rooms,"guests":m.guests,"free_cancellation_only":m.require_refundable});
        if m.accommodation_ids.is_empty() {
            body["location"] = json!({"geographic_coordinates":{"latitude":latitude,"longitude":longitude},"radius":5});
        } else {
            body["accommodation"] = json!({"ids":m.accommodation_ids});
        }
        let e = self.read("POST", "search", Some(body)).await?;
        observed(e, |data| {
            let list = data["results"]
                .as_array()
                .ok_or_else(|| TravelError::Provider("missing search results".into()))?;
            list.iter()
                .map(|v| {
                    Ok(SearchOption {
                        search_result_id: field(v, "id")?.into(),
                        accommodation: accommodation(&v["accommodation"])?,
                        displayed_total: Money::parse(
                            field(v, "cheapest_rate_total_amount")?,
                            field(v, "cheapest_rate_currency")?,
                        )?,
                    })
                })
                .collect::<Result<_>>()
        })
    }
    async fn rates(&self, search_result_id: &str) -> Result<Observed<Vec<Quote>>> {
        let e = self
            .read(
                "POST",
                &format!(
                    "search_results/{}/actions/fetch_all_rates",
                    id(search_result_id)
                ),
                Some(json!({})),
            )
            .await?;
        observed(e, |v| {
            let rooms = v["accommodation"]["rooms"]
                .as_array()
                .ok_or_else(|| TravelError::Provider("missing rooms".into()))?;
            let mut value = Vec::new();
            for room in rooms {
                for rate in room["rates"].as_array().into_iter().flatten() {
                    value.push(normalize(v, Some(field(rate, "id")?), false)?);
                }
            }
            Ok(value)
        })
    }
    async fn quote(&self, rate_id: &str) -> Result<Observed<Quote>> {
        let e = self
            .read("POST", "quotes", Some(json!({"rate_id":rate_id})))
            .await?;
        // Duffel may return a new rate identity at quote; the stored quote becomes
        // authoritative, while property/dates/guests still pass deterministic policy.
        observed(e, |v| normalize(v, None, false))
    }
    async fn create(&self, r: &BookingRequest) -> WriteOutcome {
        let guests: Vec<_> = r
            .travelers
            .iter()
            .map(|t| json!({"given_name":t.given_name,"family_name":t.family_name}))
            .collect();
        let Some(lead) = r.travelers.first() else {
            return WriteOutcome::Rejected {
                retryable: false,
                evidence: Evidence {
                    status: 0,
                    provider_request_id: None,
                    correlation_id: Some(r.request_id.clone()),
                    body: json!({"local_rejection":"missing travelers"}),
                },
            };
        };
        let body = json!({"quote_id":r.quote_id,"email":lead.email,"phone_number":lead.phone,"guests":guests,"metadata":{"burrow_transaction_id":r.transaction_id,"burrow_request_id":r.request_id}});
        // Omit payment for balance. No fictitious idempotency header.
        let e = match self
            .http
            .request("POST", "bookings", Some(body), &r.request_id)
            .await
        {
            Ok(e) => e,
            Err(_) => {
                return WriteOutcome::Uncertain(Evidence {
                    status: 0,
                    provider_request_id: None,
                    correlation_id: Some(r.request_id.clone()),
                    body: json!({"transport_outcome":"unknown"}),
                })
            }
        };
        if matches!(e.status, 200 | 201) {
            if let Ok(value) = booking(&e.body["data"]) {
                return WriteOutcome::Confirmed(Observed { value, evidence: e });
            }
        }
        // 503 is specifically guaranteed non-booked by Duffel's booking response
        // handling docs. Do not generalize that to 504, proxy errors or timeouts.
        let provider_error = e.body["errors"].as_array().is_some_and(|es| {
            !es.is_empty()
                && es.iter().all(|e| {
                    matches!(
                        e["type"].as_str(),
                        Some(
                            "validation_error"
                                | "authentication_error"
                                | "invalid_request_error"
                                | "invalid_state_error"
                                | "rate_limit_error"
                                | "fraud_error"
                        )
                    )
                })
        });
        if e.provider_request_id.is_some()
            && provider_error
            && (e.status == 503 || matches!(e.status, 400 | 401 | 403 | 404 | 406 | 422 | 429))
        {
            WriteOutcome::Rejected {
                retryable: e.status == 503,
                evidence: e,
            }
        } else if e.status == 503
            && e.provider_request_id.is_some()
            && e.body["errors"].as_array().is_some_and(|a| !a.is_empty())
        {
            WriteOutcome::Rejected {
                retryable: true,
                evidence: e,
            }
        } else {
            WriteOutcome::Uncertain(e)
        }
    }
    async fn retrieve(&self, booking_id: &str) -> Result<Observed<Booking>> {
        let e = self
            .read("GET", &format!("bookings/{}", id(booking_id)), None)
            .await?;
        observed(e, booking)
    }
    async fn list(&self, after: Option<&str>) -> Result<Observed<BookingPage>> {
        let path = format!(
            "bookings?limit=200{}",
            after
                .map(|s| format!("&after={}", id(s)))
                .unwrap_or_default()
        );
        let e = self.read("GET", &path, None).await?;
        // Do not include organization-wide list data in parsing errors returned
        // to an account. The ledger also strips list error bodies from evidence.
        let values = e.body["data"]
            .as_array()
            .ok_or_else(|| TravelError::Provider("missing booking list".into()))?;
        let value = BookingPage {
            bookings: values.iter().map(booking).collect::<Result<_>>()?,
            after: e.body["meta"]["after"].as_str().map(str::to_owned),
        };
        Ok(Observed { value, evidence: e })
    }
}
