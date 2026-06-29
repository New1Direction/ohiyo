//! Content-free push relay primitives.
//!
//! The relay stores device endpoints and queues wake-up nudges that say only
//! "you have activity". It intentionally never stores message text, filenames,
//! channel names, invite codes, or encryption keys.

use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use jsonwebtoken::{Algorithm, EncodingKey, Header};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use web_push::{
    ContentEncoding, SubscriptionInfo, VapidSignatureBuilder, WebPushError, WebPushMessageBuilder,
};

use crate::{
    auth::AuthUser,
    types::{new_id, now_unix},
    AppState,
};

const MAX_DISPATCH_BATCH: i64 = 100;
const MAX_DELIVERY_ATTEMPTS: i64 = 5;
const CONTENT_FREE_TITLE: &str = "Ohiyo";
const CONTENT_FREE_BODY: &str = "You have new activity.";

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct PushDevice {
    pub id: String,
    pub user_id: String,
    pub platform: String,
    pub endpoint: String,
    pub p256dh: Option<String>,
    pub auth: Option<String>,
    pub device_name: Option<String>,
    pub enabled: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, sqlx::FromRow)]
struct DeliveryJob {
    id: String,
    device_id: Option<String>,
    kind: String,
    attempts: i64,
    platform: Option<String>,
    endpoint: Option<String>,
    p256dh: Option<String>,
    auth: Option<String>,
}

#[derive(Serialize)]
pub struct PushConfig {
    pub enabled: bool,
    pub vapid_public_key: Option<String>,
    pub privacy_note: String,
}

#[derive(Deserialize)]
pub struct RegisterPushDeviceBody {
    pub platform: String,
    pub endpoint: String,
    pub p256dh: Option<String>,
    pub auth: Option<String>,
    pub device_name: Option<String>,
}

#[derive(Deserialize)]
pub struct RelayPushBody {
    pub recipient_ids: Vec<String>,
    pub kind: Option<String>,
}

#[derive(Serialize)]
pub struct RelayResult {
    pub queued: i64,
    pub skipped_online: i64,
    pub skipped_no_device: i64,
}

#[derive(Debug, Default, Serialize)]
pub struct DispatchResult {
    pub attempted: i64,
    pub delivered: i64,
    pub retried: i64,
    pub failed: i64,
    pub disabled_devices: i64,
    pub skipped_missing_device: i64,
    pub skipped_missing_provider: i64,
}

#[derive(Debug)]
struct SendFailure {
    retryable: bool,
    invalid_token: bool,
    reason: String,
}

enum ProviderSendResult {
    Sent,
    MissingProvider(String),
    Failed(SendFailure),
}

fn public_device(row: PushDevice) -> PushDevice {
    row
}

fn valid_platform(platform: &str) -> bool {
    matches!(platform, "web" | "apns" | "fcm")
}

fn env_truthy(name: &str) -> bool {
    std::env::var(name)
        .ok()
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(false)
}

fn dispatch_enabled() -> bool {
    env_truthy("OHIYO_PUSH_DISPATCH_ENABLED")
}

fn relay_secret_ok(headers: &HeaderMap) -> bool {
    let Some(secret) = std::env::var("OHIYO_PUSH_RELAY_SECRET")
        .ok()
        .filter(|s| !s.is_empty())
    else {
        return false;
    };
    let Some(value) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
    else {
        return false;
    };
    value
        .strip_prefix("Bearer ")
        .map(|got| got == secret)
        .unwrap_or(false)
}

fn is_user_online(state: &AppState, user_id: &str) -> bool {
    state
        .sessions
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .get(user_id)
        .map(|m| !m.is_empty())
        .unwrap_or(false)
}

fn content_free_payload(kind: &str) -> serde_json::Value {
    json!({
        "title": CONTENT_FREE_TITLE,
        "body": match kind {
            "test" => "This is a test Ohiyo notification.",
            _ => CONTENT_FREE_BODY,
        },
        "tag": "ohiyo-activity",
        "data": { "kind": kind },
    })
}

fn privacy_note() -> String {
    "Push notifications are content-free: the relay may learn device endpoint, recipient id, and delivery time, but not message text, filenames, channel names, or E2E keys.".into()
}

pub async fn config() -> Json<PushConfig> {
    let key = std::env::var("OHIYO_WEB_PUSH_PUBLIC_KEY")
        .ok()
        .filter(|s| !s.is_empty());
    Json(PushConfig {
        enabled: key.is_some(),
        vapid_public_key: key,
        privacy_note: privacy_note(),
    })
}

pub async fn list_devices(
    auth: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<PushDevice>>, (StatusCode, String)> {
    let rows = sqlx::query_as::<_, PushDevice>(
        "SELECT * FROM push_devices WHERE user_id = ? AND enabled = 1 ORDER BY updated_at DESC",
    )
    .bind(&auth.0)
    .fetch_all(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(Json(rows.into_iter().map(public_device).collect()))
}

pub async fn register_device(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<RegisterPushDeviceBody>,
) -> Result<Json<PushDevice>, (StatusCode, String)> {
    let platform = body.platform.trim().to_lowercase();
    let endpoint = body.endpoint.trim();
    if !valid_platform(&platform) {
        return Err((
            StatusCode::BAD_REQUEST,
            "platform must be web, apns, or fcm".into(),
        ));
    }
    if endpoint.is_empty() || endpoint.len() > 2048 {
        return Err((StatusCode::BAD_REQUEST, "endpoint is required".into()));
    }
    if platform == "web"
        && (body.p256dh.as_deref().unwrap_or_default().is_empty()
            || body.auth.as_deref().unwrap_or_default().is_empty())
    {
        return Err((
            StatusCode::BAD_REQUEST,
            "web push requires p256dh and auth keys".into(),
        ));
    }

    let id = new_id();
    let now = now_unix();
    sqlx::query(
        "INSERT INTO push_devices (id, user_id, platform, endpoint, p256dh, auth, device_name, enabled, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(user_id, endpoint) DO UPDATE SET
           platform=excluded.platform,
           p256dh=excluded.p256dh,
           auth=excluded.auth,
           device_name=excluded.device_name,
           enabled=1,
           updated_at=excluded.updated_at",
    )
    .bind(&id)
    .bind(&auth.0)
    .bind(&platform)
    .bind(endpoint)
    .bind(body.p256dh.as_deref())
    .bind(body.auth.as_deref())
    .bind(body.device_name.as_deref())
    .bind(1_i64)
    .bind(now)
    .bind(now)
    .execute(&state.db)
    .await
    .map_err(crate::api::error::internal)?;

    let row = sqlx::query_as::<_, PushDevice>(
        "SELECT * FROM push_devices WHERE user_id = ? AND endpoint = ?",
    )
    .bind(&auth.0)
    .bind(endpoint)
    .fetch_one(&state.db)
    .await
    .map_err(crate::api::error::internal)?;
    Ok(Json(public_device(row)))
}

pub async fn delete_device(
    auth: AuthUser,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<StatusCode, (StatusCode, String)> {
    let res =
        sqlx::query("UPDATE push_devices SET enabled=0, updated_at=? WHERE id=? AND user_id=?")
            .bind(now_unix())
            .bind(id)
            .bind(&auth.0)
            .execute(&state.db)
            .await
            .map_err(crate::api::error::internal)?;
    if res.rows_affected() == 0 {
        return Err((StatusCode::NOT_FOUND, "push device not found".into()));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn queue_for_users(
    state: &AppState,
    recipient_ids: &[String],
    kind: &str,
    skip_online: bool,
) -> Result<RelayResult, sqlx::Error> {
    let mut result = RelayResult {
        queued: 0,
        skipped_online: 0,
        skipped_no_device: 0,
    };
    for user_id in recipient_ids {
        if skip_online && is_user_online(state, user_id) {
            result.skipped_online += 1;
            continue;
        }
        let devices: Vec<(String,)> =
            sqlx::query_as("SELECT id FROM push_devices WHERE user_id = ? AND enabled = 1")
                .bind(user_id)
                .fetch_all(&state.db)
                .await?;
        if devices.is_empty() {
            result.skipped_no_device += 1;
            continue;
        }
        for (device_id,) in devices {
            sqlx::query(
                "INSERT INTO push_deliveries (id, user_id, device_id, kind, status, attempts, created_at)
                 VALUES (?,?,?,?,?,?,?)",
            )
            .bind(new_id())
            .bind(user_id)
            .bind(device_id)
            .bind(kind)
            .bind("queued")
            .bind(0_i64)
            .bind(now_unix())
            .execute(&state.db)
            .await?;
            result.queued += 1;
        }
    }
    Ok(result)
}

/// Called by hosted community servers or the control plane. Auth uses a shared relay
/// secret so sleeping per-community instances can ask the always-on relay to notify
/// devices without exposing any message content.
pub async fn relay_content_free(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(body): Json<RelayPushBody>,
) -> Result<Json<RelayResult>, (StatusCode, String)> {
    if !relay_secret_ok(&headers) {
        return Err((
            StatusCode::UNAUTHORIZED,
            "missing or invalid push relay secret".into(),
        ));
    }
    let kind = body.kind.as_deref().unwrap_or("message");
    if !matches!(kind, "message" | "test") {
        return Err((
            StatusCode::BAD_REQUEST,
            "kind must be message or test".into(),
        ));
    }
    let result = queue_for_users(&state, &body.recipient_ids, kind, true)
        .await
        .map_err(crate::api::error::internal)?;
    Ok(Json(result))
}

pub async fn dispatch_content_free(
    headers: HeaderMap,
    State(state): State<AppState>,
) -> Result<Json<DispatchResult>, (StatusCode, String)> {
    if !relay_secret_ok(&headers) {
        return Err((
            StatusCode::UNAUTHORIZED,
            "missing or invalid push relay secret".into(),
        ));
    }
    let result = dispatch_queued(&state, MAX_DISPATCH_BATCH)
        .await
        .map_err(crate::api::error::internal)?;
    Ok(Json(result))
}

/// Internal hook for a newly-created message. Figures out the channel audience,
/// removes the author, skips online users, and queues content-free nudges.
pub async fn enqueue_message_pushes(state: &AppState, channel_id: &str, author_id: &str) {
    let rows: Result<Vec<(String,)>, sqlx::Error> = sqlx::query_as(
        "SELECT sm.user_id
           FROM channels c JOIN server_members sm ON sm.server_id = c.server_id
          WHERE c.id = ? AND c.server_id IS NOT NULL
         UNION
         SELECT dp.user_id
           FROM dm_participants dp JOIN channels c ON c.id = dp.channel_id
          WHERE c.id = ? AND c.server_id IS NULL",
    )
    .bind(channel_id)
    .bind(channel_id)
    .fetch_all(&state.db)
    .await;

    let Ok(rows) = rows else {
        return;
    };
    let is_server_channel: bool =
        sqlx::query_scalar::<_, Option<String>>("SELECT server_id FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten()
            .flatten()
            .is_some();
    let mut recipients = Vec::new();
    for (id,) in rows {
        if id == author_id {
            continue;
        }
        if crate::api::abuse::is_blocked_pair(state, author_id, &id).await {
            continue;
        }
        if is_server_channel
            && !crate::api::roles::has_channel_perm(
                state,
                channel_id,
                &id,
                crate::api::roles::perm::VIEW_CHANNEL,
            )
            .await
        {
            continue;
        }
        recipients.push(id);
    }
    if recipients.is_empty() {
        return;
    }
    if let Err(e) = queue_for_users(state, &recipients, "message", true).await {
        tracing::warn!("content-free push enqueue failed for channel {channel_id}: {e}");
    }
}

pub async fn dispatch_queued(state: &AppState, limit: i64) -> Result<DispatchResult, sqlx::Error> {
    let now = now_unix();
    let rows: Vec<DeliveryJob> = sqlx::query_as(
        "SELECT pd.id, pd.device_id, pd.kind, pd.attempts,
                d.platform, d.endpoint, d.p256dh, d.auth
         FROM push_deliveries pd
         LEFT JOIN push_devices d ON d.id = pd.device_id AND d.enabled = 1
         WHERE pd.status = 'queued'
           AND (pd.next_attempt_at IS NULL OR pd.next_attempt_at <= ?)
         ORDER BY pd.created_at ASC
         LIMIT ?",
    )
    .bind(now)
    .bind(limit.clamp(1, MAX_DISPATCH_BATCH))
    .fetch_all(&state.db)
    .await?;

    let mut result = DispatchResult::default();
    let http = Client::new();
    for job in rows {
        result.attempted += 1;
        let Some(platform) = job.platform.as_deref() else {
            mark_failed(state, &job, now, "device missing or disabled", false, false).await?;
            result.skipped_missing_device += 1;
            result.failed += 1;
            continue;
        };
        let send_result = send_job(&http, &job, platform).await;
        match send_result {
            ProviderSendResult::Sent => {
                mark_delivered(state, &job.id, now).await?;
                result.delivered += 1;
            }
            ProviderSendResult::MissingProvider(reason) => {
                mark_retry(state, &job, now, &reason).await?;
                result.skipped_missing_provider += 1;
                result.retried += 1;
            }
            ProviderSendResult::Failed(failure) => {
                if failure.invalid_token {
                    if let Some(device_id) = job.device_id.as_deref() {
                        disable_device(state, device_id, now).await?;
                        result.disabled_devices += 1;
                    }
                }
                if failure.retryable && job.attempts + 1 < MAX_DELIVERY_ATTEMPTS {
                    mark_retry(state, &job, now, &failure.reason).await?;
                    result.retried += 1;
                } else {
                    mark_failed(
                        state,
                        &job,
                        now,
                        &failure.reason,
                        failure.invalid_token,
                        true,
                    )
                    .await?;
                    result.failed += 1;
                }
            }
        }
    }
    Ok(result)
}

async fn send_job(http: &Client, job: &DeliveryJob, platform: &str) -> ProviderSendResult {
    match platform {
        "web" => send_web_push(http, job).await,
        "apns" => send_apns(http, job).await,
        "fcm" => send_fcm(http, job).await,
        _ => ProviderSendResult::Failed(SendFailure {
            retryable: false,
            invalid_token: false,
            reason: "unknown push platform".to_owned(),
        }),
    }
}

async fn send_web_push(http: &Client, job: &DeliveryJob) -> ProviderSendResult {
    let private_key = match std::env::var("OHIYO_WEB_PUSH_PRIVATE_KEY_PEM")
        .or_else(|_| std::env::var("OHIYO_WEB_PUSH_PRIVATE_KEY"))
    {
        Ok(v) if !v.trim().is_empty() => v,
        _ => {
            return ProviderSendResult::MissingProvider(
                "web push VAPID private key missing".to_owned(),
            )
        }
    };
    let subject = std::env::var("OHIYO_WEB_PUSH_SUBJECT")
        .unwrap_or_else(|_| "mailto:security@ohiyo.gg".to_owned());
    let Some(endpoint) = job.endpoint.as_deref() else {
        return ProviderSendResult::Failed(permanent("web push endpoint missing"));
    };
    let Some(p256dh) = job.p256dh.as_deref() else {
        return ProviderSendResult::Failed(permanent("web push p256dh missing"));
    };
    let Some(auth) = job.auth.as_deref() else {
        return ProviderSendResult::Failed(permanent("web push auth missing"));
    };
    let subscription = SubscriptionInfo::new(endpoint, p256dh, auth);
    let mut sig = match VapidSignatureBuilder::from_pem(private_key.as_bytes(), &subscription) {
        Ok(builder) => builder,
        Err(_) => {
            return ProviderSendResult::MissingProvider("web push VAPID key invalid".to_owned())
        }
    };
    sig.add_claim("sub", subject);
    let signature = match sig.build() {
        Ok(sig) => sig,
        Err(_) => {
            return ProviderSendResult::MissingProvider(
                "web push VAPID signature failed".to_owned(),
            )
        }
    };
    let payload = content_free_payload(&job.kind).to_string();
    let mut builder = WebPushMessageBuilder::new(&subscription);
    builder.set_payload(ContentEncoding::Aes128Gcm, payload.as_bytes());
    builder.set_vapid_signature(signature);
    let message = match builder.build() {
        Ok(message) => message,
        Err(err) => return ProviderSendResult::Failed(web_push_failure(err)),
    };
    let mut request = http
        .post(message.endpoint.to_string())
        .header("TTL", message.ttl.to_string());
    if let Some(urgency) = message.urgency {
        request = request.header("Urgency", urgency.to_string());
    }
    if let Some(topic) = message.topic {
        request = request.header("Topic", topic);
    }
    if let Some(payload) = message.payload {
        request = request.header("Content-Encoding", payload.content_encoding.to_str());
        for (name, value) in payload.crypto_headers {
            request = request.header(name, value);
        }
        request = request.body(payload.content);
    }
    match request.send().await {
        Ok(res) if res.status().is_success() => ProviderSendResult::Sent,
        Ok(res) if res.status().as_u16() == 404 || res.status().as_u16() == 410 => {
            ProviderSendResult::Failed(SendFailure {
                retryable: false,
                invalid_token: true,
                reason: "web push endpoint expired".to_owned(),
            })
        }
        Ok(res) if res.status().is_server_error() || res.status().as_u16() == 429 => {
            ProviderSendResult::Failed(transient("web push provider unavailable"))
        }
        Ok(_) => ProviderSendResult::Failed(permanent("web push delivery failed")),
        Err(_) => ProviderSendResult::Failed(transient("web push request failed")),
    }
}

fn web_push_failure(err: WebPushError) -> SendFailure {
    match err {
        WebPushError::EndpointNotFound(_) | WebPushError::EndpointNotValid(_) => SendFailure {
            retryable: false,
            invalid_token: true,
            reason: "web push endpoint expired".to_owned(),
        },
        WebPushError::Unauthorized(_) | WebPushError::BadRequest(_) | WebPushError::InvalidUri => {
            SendFailure {
                retryable: false,
                invalid_token: false,
                reason: "web push request rejected".to_owned(),
            }
        }
        WebPushError::ServerError { .. } | WebPushError::Unspecified => {
            transient("web push provider unavailable")
        }
        _ => permanent("web push delivery failed"),
    }
}

#[derive(Serialize)]
struct ApnsClaims {
    iss: String,
    iat: i64,
}

async fn send_apns(http: &Client, job: &DeliveryJob) -> ProviderSendResult {
    let key_id = match std::env::var("OHIYO_APNS_KEY_ID") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => return ProviderSendResult::MissingProvider("APNs key id missing".to_owned()),
    };
    let team_id = match std::env::var("OHIYO_APNS_TEAM_ID") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => return ProviderSendResult::MissingProvider("APNs team id missing".to_owned()),
    };
    let topic = match std::env::var("OHIYO_APNS_TOPIC") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => return ProviderSendResult::MissingProvider("APNs topic missing".to_owned()),
    };
    let p8 = match std::env::var("OHIYO_APNS_PRIVATE_KEY_P8") {
        Ok(v) if !v.trim().is_empty() => v,
        _ => return ProviderSendResult::MissingProvider("APNs private key missing".to_owned()),
    };
    let Some(token) = job.endpoint.as_deref() else {
        return ProviderSendResult::Failed(permanent("APNs token missing"));
    };
    let mut header = Header::new(Algorithm::ES256);
    header.kid = Some(key_id);
    let encoding_key = match EncodingKey::from_ec_pem(p8.as_bytes()) {
        Ok(key) => key,
        Err(_) => {
            return ProviderSendResult::MissingProvider("APNs private key invalid".to_owned())
        }
    };
    let jwt = match jsonwebtoken::encode(
        &header,
        &ApnsClaims {
            iss: team_id,
            iat: now_unix(),
        },
        &encoding_key,
    ) {
        Ok(jwt) => jwt,
        Err(_) => {
            return ProviderSendResult::MissingProvider("APNs private key invalid".to_owned())
        }
    };
    let host = if env_truthy("OHIYO_APNS_SANDBOX") {
        "https://api.sandbox.push.apple.com"
    } else {
        "https://api.push.apple.com"
    };
    let url = format!("{host}/3/device/{token}");
    let payload = apns_payload(&job.kind);
    let res = http
        .post(url)
        .bearer_auth(jwt)
        .header("apns-topic", topic)
        .header("apns-push-type", "alert")
        .header("apns-priority", "10")
        .json(&payload)
        .send()
        .await;
    let Ok(res) = res else {
        return ProviderSendResult::Failed(transient("APNs request failed"));
    };
    let status = res.status();
    if status.is_success() {
        return ProviderSendResult::Sent;
    }
    let body: serde_json::Value = res.json().await.unwrap_or_else(|_| json!({}));
    let reason = body
        .get("reason")
        .and_then(|v| v.as_str())
        .unwrap_or("APNs rejected notification");
    let invalid = matches!(
        reason,
        "BadDeviceToken" | "Unregistered" | "DeviceTokenNotForTopic"
    );
    ProviderSendResult::Failed(SendFailure {
        retryable: status.is_server_error() || status.as_u16() == 429,
        invalid_token: invalid,
        reason: if invalid {
            "APNs token invalid"
        } else {
            "APNs delivery failed"
        }
        .to_owned(),
    })
}

fn apns_payload(kind: &str) -> serde_json::Value {
    json!({
        "aps": {
            "alert": {
                "title": CONTENT_FREE_TITLE,
                "body": match kind {
                    "test" => "This is a test Ohiyo notification.",
                    _ => CONTENT_FREE_BODY,
                }
            },
            "sound": "default",
            "thread-id": "ohiyo"
        },
        "kind": kind
    })
}

#[derive(Deserialize)]
struct FcmServiceAccount {
    project_id: String,
    client_email: String,
    private_key: String,
    #[serde(default)]
    token_uri: Option<String>,
}

#[derive(Serialize)]
struct FcmClaims<'a> {
    iss: &'a str,
    scope: &'a str,
    aud: &'a str,
    iat: i64,
    exp: i64,
}

async fn send_fcm(http: &Client, job: &DeliveryJob) -> ProviderSendResult {
    let account = match fcm_service_account() {
        Ok(Some(account)) => account,
        Ok(None) => {
            return ProviderSendResult::MissingProvider("FCM service account missing".to_owned())
        }
        Err(_) => {
            return ProviderSendResult::MissingProvider("FCM service account invalid".to_owned())
        }
    };
    let token = match fcm_access_token(http, &account).await {
        Ok(token) => token,
        Err(reason) => return ProviderSendResult::Failed(transient(&reason)),
    };
    let Some(device_token) = job.endpoint.as_deref() else {
        return ProviderSendResult::Failed(permanent("FCM token missing"));
    };
    let url = format!(
        "https://fcm.googleapis.com/v1/projects/{}/messages:send",
        account.project_id
    );
    let payload = fcm_payload(device_token, &job.kind);
    let res = http
        .post(url)
        .bearer_auth(token)
        .json(&payload)
        .send()
        .await;
    let Ok(res) = res else {
        return ProviderSendResult::Failed(transient("FCM request failed"));
    };
    let status = res.status();
    if status.is_success() {
        return ProviderSendResult::Sent;
    }
    let body: serde_json::Value = res.json().await.unwrap_or_else(|_| json!({}));
    let body_text = body.to_string();
    let invalid = body_text.contains("UNREGISTERED")
        || body_text.contains("INVALID_ARGUMENT")
        || body_text.contains("registration-token-not-registered");
    ProviderSendResult::Failed(SendFailure {
        retryable: status.is_server_error() || status.as_u16() == 429,
        invalid_token: invalid,
        reason: if invalid {
            "FCM token invalid"
        } else {
            "FCM delivery failed"
        }
        .to_owned(),
    })
}

fn fcm_service_account() -> Result<Option<FcmServiceAccount>, serde_json::Error> {
    if let Ok(raw) = std::env::var("OHIYO_FCM_SERVICE_ACCOUNT_JSON") {
        if !raw.trim().is_empty() {
            return serde_json::from_str(&raw).map(Some);
        }
    }
    if let Ok(path) = std::env::var("OHIYO_FCM_SERVICE_ACCOUNT_FILE") {
        if !path.trim().is_empty() {
            let raw = std::fs::read_to_string(path).unwrap_or_default();
            if raw.trim().is_empty() {
                return Ok(None);
            }
            return serde_json::from_str(&raw).map(Some);
        }
    }
    Ok(None)
}

async fn fcm_access_token(http: &Client, account: &FcmServiceAccount) -> Result<String, String> {
    let token_uri = account
        .token_uri
        .as_deref()
        .unwrap_or("https://oauth2.googleapis.com/token");
    let now = now_unix();
    let mut header = Header::new(Algorithm::RS256);
    header.typ = Some("JWT".to_owned());
    let assertion = jsonwebtoken::encode(
        &header,
        &FcmClaims {
            iss: &account.client_email,
            scope: "https://www.googleapis.com/auth/firebase.messaging",
            aud: token_uri,
            iat: now,
            exp: now + 3600,
        },
        &EncodingKey::from_rsa_pem(account.private_key.as_bytes())
            .map_err(|_| "FCM private key invalid".to_owned())?,
    )
    .map_err(|_| "FCM JWT signing failed".to_owned())?;
    let res = http
        .post(token_uri)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", assertion.as_str()),
        ])
        .send()
        .await
        .map_err(|_| "FCM token request failed".to_owned())?;
    if !res.status().is_success() {
        return Err("FCM token request rejected".to_owned());
    }
    let body: serde_json::Value = res
        .json()
        .await
        .map_err(|_| "FCM token response invalid".to_owned())?;
    body.get("access_token")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .ok_or_else(|| "FCM access token missing".to_owned())
}

fn fcm_payload(token: &str, kind: &str) -> serde_json::Value {
    json!({
        "message": {
            "token": token,
            "notification": {
                "title": CONTENT_FREE_TITLE,
                "body": match kind {
                    "test" => "This is a test Ohiyo notification.",
                    _ => CONTENT_FREE_BODY,
                }
            },
            "data": { "kind": kind },
            "android": { "priority": "HIGH" },
            "apns": { "payload": apns_payload(kind) }
        }
    })
}

fn transient(reason: &str) -> SendFailure {
    SendFailure {
        retryable: true,
        invalid_token: false,
        reason: reason.to_owned(),
    }
}

fn permanent(reason: &str) -> SendFailure {
    SendFailure {
        retryable: false,
        invalid_token: false,
        reason: reason.to_owned(),
    }
}

async fn mark_delivered(state: &AppState, delivery_id: &str, now: i64) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE push_deliveries
         SET status='delivered', attempts=attempts+1, last_attempt_at=?, dispatched_at=?, last_error=NULL
         WHERE id=?",
    )
    .bind(now)
    .bind(now)
    .bind(delivery_id)
    .execute(&state.db)
    .await?;
    Ok(())
}

async fn mark_retry(
    state: &AppState,
    job: &DeliveryJob,
    now: i64,
    reason: &str,
) -> Result<(), sqlx::Error> {
    let attempts = job.attempts + 1;
    let backoff_secs = retry_delay_secs(attempts);
    sqlx::query(
        "UPDATE push_deliveries
         SET attempts=?, last_attempt_at=?, next_attempt_at=?, last_error=?
         WHERE id=?",
    )
    .bind(attempts)
    .bind(now)
    .bind(now + backoff_secs)
    .bind(sanitize_error(reason))
    .bind(&job.id)
    .execute(&state.db)
    .await?;
    Ok(())
}

async fn mark_failed(
    state: &AppState,
    job: &DeliveryJob,
    now: i64,
    reason: &str,
    invalid_token: bool,
    increment_attempt: bool,
) -> Result<(), sqlx::Error> {
    let attempts = if increment_attempt {
        job.attempts + 1
    } else {
        job.attempts
    };
    let reason = if invalid_token {
        "push token invalid or expired"
    } else {
        reason
    };
    sqlx::query(
        "UPDATE push_deliveries
         SET status='failed', attempts=?, last_attempt_at=?, next_attempt_at=NULL, last_error=?
         WHERE id=?",
    )
    .bind(attempts)
    .bind(now)
    .bind(sanitize_error(reason))
    .bind(&job.id)
    .execute(&state.db)
    .await?;
    Ok(())
}

async fn disable_device(state: &AppState, device_id: &str, now: i64) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE push_devices SET enabled=0, updated_at=? WHERE id=?")
        .bind(now)
        .bind(device_id)
        .execute(&state.db)
        .await?;
    Ok(())
}

fn retry_delay_secs(attempts: i64) -> i64 {
    match attempts {
        0 | 1 => 30,
        2 => 120,
        3 => 600,
        _ => 1800,
    }
}

fn sanitize_error(reason: &str) -> String {
    reason.chars().take(160).collect()
}

pub async fn sweep_stale_push_rows(state: &AppState) {
    let cutoff = now_unix() - 30 * 86_400;
    if let Err(e) = sqlx::query(
        "DELETE FROM push_deliveries
         WHERE status IN ('delivered','failed','skipped') AND created_at < ?",
    )
    .bind(cutoff)
    .execute(&state.db)
    .await
    {
        tracing::warn!("push delivery GC failed: {e}");
    }
}

pub fn dispatcher_should_run() -> bool {
    dispatch_enabled()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_copy_never_mentions_content_fields() {
        let note = privacy_note();
        assert!(note.contains("content-free"));
        assert!(note.contains("not message text"));
    }

    #[test]
    fn content_free_payload_contains_no_content_identifiers() {
        let payload = content_free_payload("message").to_string();
        assert!(payload.contains("Ohiyo"));
        for forbidden in [
            "message_text",
            "content",
            "channel_id",
            "channel_name",
            "server_name",
            "filename",
            "invite",
            "key",
        ] {
            assert!(
                !payload.to_ascii_lowercase().contains(forbidden),
                "payload should not contain {forbidden}: {payload}"
            );
        }
    }

    #[test]
    fn fcm_and_apns_payloads_are_generic() {
        let fcm = fcm_payload("token-redacted", "message").to_string();
        let apns = apns_payload("message").to_string();
        for payload in [fcm, apns] {
            assert!(payload.contains("Ohiyo"));
            assert!(payload.contains("message"));
            assert!(!payload.contains("channel"));
            assert!(!payload.contains("filename"));
            assert!(!payload.contains("invite"));
        }
    }
}
