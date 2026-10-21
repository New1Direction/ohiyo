//! Explicit operator-approved routes. Credentials never enter the durable admission.
use super::Error;
use crate::{
    api::error::internal,
    auth::{two_factor::SecretBox, AuthUser},
    AppState,
};
use axum::{
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    Json,
};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};

pub const ROLES: [&str; 4] = ["general", "research", "review", "summary"];

// Browser JSON round trips turn integral prices such as 0.0 into 0.
// Compare their numeric value without relaxing any other approval terms.
pub(super) fn same_snapshot(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (Some(Value::Number(a)), Some(Value::Number(b))) if a.is_f64() || b.is_f64() => {
            a.as_f64() == b.as_f64()
        }
        (Some(Value::Object(a)), Some(Value::Object(b))) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(key, value)| same_snapshot(Some(value), b.get(key)))
        }
        _ => left == right,
    }
}

fn bad() -> Error {
    (
        StatusCode::BAD_REQUEST,
        "Invalid or unavailable model routing.".into(),
    )
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Model {
    pub id: String,
    pub provider_model_id: String,
    pub context_window: u64,
    pub max_output_tokens: u64,
    pub input_usd_per_million: f64,
    pub output_usd_per_million: f64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Template {
    pub id: String,
    pub name: String,
    pub endpoint: String,
    pub model_mapping: String,
    pub active: bool,
    pub priority: usize,
    pub key_env: Option<String>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub catalog: Vec<Model>,
    pub connections: Vec<Template>,
    pub roles: BTreeMap<String, String>,
}
#[derive(Clone)]
pub struct Routing {
    pub config: Config,
    pub secret_box: Option<SecretBox>,
    keys: BTreeMap<String, String>,
}
impl Routing {
    pub fn new(
        config: Config,
        secret_box: Option<SecretBox>,
        keys: BTreeMap<String, String>,
    ) -> Result<Self, String> {
        config
            .validate()
            .map_err(|_| "Invalid Kikka routing configuration.".to_owned())?;
        if keys.iter().any(|(id, key)| {
            !short(key, 4096)
                || !config
                    .connections
                    .iter()
                    .any(|t| &t.id == id && t.key_env.as_ref().is_some_and(|e| short(e, 200)))
        }) {
            return Err("Invalid Kikka routing credentials.".into());
        }
        Ok(Self {
            config,
            secret_box,
            keys,
        })
    }
    pub fn from_env() -> Option<Self> {
        let path = std::env::var("KIKKA_ROUTING_CONFIG").ok()?;
        let result = (|| {
            let config: Config =
                serde_json::from_slice(&std::fs::read(path).map_err(|_| ())?).map_err(|_| ())?;
            config.validate().map_err(|_| ())?;
            // Production templates must resolve only to public addresses at load.
            // Dispatch must enforce the same network boundary to defeat DNS rebinding.
            for t in &config.connections {
                use std::net::ToSocketAddrs;
                let u = url::Url::parse(&t.endpoint).map_err(|_| ())?;
                let addresses: Vec<_> = (u.host_str().ok_or(())?, 443)
                    .to_socket_addrs()
                    .map_err(|_| ())?
                    .collect();
                if addresses.is_empty() || addresses.iter().any(|a| !public_ip(a.ip())) {
                    return Err(());
                }
            }
            let keys = config
                .connections
                .iter()
                .filter_map(|c| {
                    c.key_env
                        .as_ref()
                        .and_then(|e| std::env::var(e).ok())
                        .filter(|v| !v.trim().is_empty())
                        .map(|k| (c.id.clone(), k))
                })
                .collect();
            let secret_box = std::env::var("KIKKA_CONNECTION_KEY")
                .ok()
                .filter(|k| k.len() >= 32)
                .map(|k| SecretBox::new(k.as_bytes()));
            Self::new(config, secret_box, keys).map_err(|_| ())
        })();
        // Explicit invalid configuration fails closed, never legacy inference.
        Some(result.unwrap_or_else(|_| Self {
            config: Config {
                catalog: vec![],
                connections: vec![],
                roles: BTreeMap::new(),
            },
            secret_box: None,
            keys: BTreeMap::new(),
        }))
    }
}
fn short(s: &str, n: usize) -> bool {
    !s.trim().is_empty() && s.len() <= n && !s.chars().any(char::is_control)
}
fn public_ip(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v) => {
            let [a, b, c, _] = v.octets();
            !v.is_private()
                && !v.is_loopback()
                && !v.is_link_local()
                && !v.is_unspecified()
                && a != 0
                && a < 224
                && !(a == 100 && (64..=127).contains(&b))
                && !(a == 192 && b == 0)
                && !(a == 192 && b == 2)
                && !(a == 198 && (b == 18 || b == 19 || (b == 51 && c == 100)))
                && !(a == 203 && b == 0 && c == 113)
        }
        std::net::IpAddr::V6(v) => {
            let s = v.segments();
            (s[0] & 0xe000) == 0x2000 && !(s[0] == 0x2001 && (s[1] == 0xdb8 || s[1] < 0x200))
        }
    }
}
impl Config {
    fn validate(&self) -> Result<(), Error> {
        if self.catalog.len() > 200 || self.connections.len() > 50 {
            return Err(bad());
        }
        let mut ids = HashSet::new();
        for m in &self.catalog {
            if !short(&m.id, 200)
                || !ids.insert(&m.id)
                || !short(&m.provider_model_id, 200)
                || m.context_window == 0
                || m.context_window > 2_000_000
                || m.max_output_tokens == 0
                || m.max_output_tokens > 65536
                || !m.input_usd_per_million.is_finite()
                || m.input_usd_per_million < 0.0
                || !m.output_usd_per_million.is_finite()
                || m.output_usd_per_million < 0.0
            {
                return Err(bad());
            }
        }
        self.validate_roles(&self.roles)?;
        let mut ids = HashSet::new();
        for c in &self.connections {
            let u = url::Url::parse(&c.endpoint).map_err(|_| bad())?;
            let host = u.host_str().ok_or_else(bad)?;
            if !short(&c.id, 100)
                || !ids.insert(&c.id)
                || !short(&c.name, 100)
                || u.scheme() != "https"
                || !u.path().ends_with("/chat/completions")
                || u.query().is_some()
                || u.fragment().is_some()
                || !u.username().is_empty()
                || u.password().is_some()
                || u.port().is_some_and(|p| p != 443)
                || !host.contains('.')
                || host.ends_with('.')
                || host == "opencode.ai"
                || host.ends_with(".localhost")
                || host.ends_with(".local")
                || host.parse::<std::net::IpAddr>().is_ok()
            {
                return Err(bad());
            }
            mapping(&c.model_mapping, "", "")?;
        }
        Ok(())
    }
    fn validate_roles(&self, r: &BTreeMap<String, String>) -> Result<(), Error> {
        if r.len() != 4
            || ROLES.iter().any(|k| !r.contains_key(*k))
            || r.values().any(|v| !self.catalog.iter().any(|m| &m.id == v))
        {
            Err(bad())
        } else {
            Ok(())
        }
    }
}
// Parse every line even after a match, so malformed inactive rules are rejected too.
pub fn mapping(text: &str, model: &str, default: &str) -> Result<Option<String>, Error> {
    if text.len() > 16000 || text.lines().count() > 200 {
        return Err(bad());
    }
    let mut found = None;
    let mut has_rules = false;
    for line in text.lines() {
        let line = line.split('#').next().unwrap().trim();
        if line.is_empty() {
            continue;
        }
        has_rules = true;
        let parts: Vec<_> = line.split("->").map(str::trim).collect();
        if parts.len() > 2 {
            return Err(bad());
        }
        let exclude = parts[0].starts_with('-');
        let p = parts[0].trim_start_matches('-');
        if !short(p, 200) || p.chars().any(char::is_whitespace) || parts[0].starts_with("--") {
            return Err(bad());
        }
        let middle = p.trim_matches('*');
        if middle.contains('*')
            || p.starts_with("**")
            || p.ends_with("**")
            || !p
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_./:*-".contains(&b))
        {
            return Err(bad());
        }
        if parts.len() == 2
            && (exclude
                || p.contains('*')
                || !short(parts[1], 200)
                || parts[1].chars().any(char::is_whitespace))
        {
            return Err(bad());
        }
        let matches = if p.starts_with('*') && p.ends_with('*') {
            model.contains(middle)
        } else if p.starts_with('*') {
            model.ends_with(middle)
        } else if p.ends_with('*') {
            model.starts_with(middle)
        } else {
            model == p
        };
        if matches {
            found = if exclude {
                None
            } else {
                Some(parts.get(1).copied().unwrap_or(default).to_owned())
            };
        }
    }
    Ok(if has_rules {
        found
    } else {
        Some(default.to_owned())
    })
}
#[derive(sqlx::FromRow)]
struct Personal {
    id: String,
    name: String,
    template_id: String,
    model_mapping: String,
    active: bool,
    priority: i64,
    ciphertext: Vec<u8>,
    revision: String,
}
async fn personal(s: &AppState, u: &str) -> Result<Vec<Personal>, Error> {
    sqlx::query_as("SELECT * FROM kikka_connections WHERE owner=? ORDER BY priority,id")
        .bind(u)
        .fetch_all(&s.db)
        .await
        .map_err(internal)
}
fn configured(s: &AppState) -> Result<&Routing, Error> {
    let kikka = s.kikka.as_ref().ok_or_else(bad)?;
    if let Some(routing) = kikka.routing.as_ref() {
        return Ok(routing);
    }
    if kikka.pi.is_none() {
        return Err(bad());
    }
    // Subscription-only installations need no operator API key or paid default.
    static EMPTY: std::sync::OnceLock<Routing> = std::sync::OnceLock::new();
    Ok(EMPTY.get_or_init(|| Routing {
        config: Config {
            catalog: vec![],
            connections: vec![],
            roles: BTreeMap::new(),
        },
        secret_box: None,
        keys: BTreeMap::new(),
    }))
}
async fn roles(s: &AppState, u: &str, r: &Routing) -> Result<BTreeMap<String, String>, Error> {
    let saved: Option<String> = sqlx::query_scalar("SELECT roles FROM kikka_roles WHERE owner=?")
        .bind(u)
        .fetch_optional(&s.db)
        .await
        .map_err(internal)?;
    saved
        .map(|v| serde_json::from_str(&v).map_err(internal))
        .unwrap_or_else(|| Ok(r.config.roles.clone()))
}
fn revision(r: &Routing, t: &Template, version: &str) -> String {
    format!(
        "{:x}",
        Sha256::digest(json!([r.config, t, version]).to_string())
    )
}
fn personal_version(p: &Personal) -> String {
    json!([
        p.id,
        p.name,
        p.template_id,
        p.model_mapping,
        p.active,
        p.priority,
        p.revision
    ])
    .to_string()
}
async fn operator_version(s: &AppState, id: &str, key: &str) -> Result<String, Error> {
    // This is only the operator's credential version journal. Personal credentials
    // always require the dedicated KIKKA_CONNECTION_KEY, never the bridge token.
    let pi = s
        .kikka
        .as_ref()
        .and_then(|k| k.pi.as_ref())
        .ok_or_else(bad)?;
    let box_ = SecretBox::new(pi.token.as_bytes());
    let aad = format!("kikka-operator:{id}");
    let mut tx = s.db.begin_with("BEGIN IMMEDIATE").await.map_err(internal)?;
    let old: Option<(Vec<u8>, String)> =
        sqlx::query_as("SELECT ciphertext,revision FROM kikka_operator_versions WHERE id=?")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await
            .map_err(internal)?;
    if let Some((blob, version)) = old {
        if box_.open(&aad, &blob).as_deref() == Some(key.as_bytes()) {
            return Ok(version);
        }
    }
    let version = crate::types::new_id();
    sqlx::query("INSERT INTO kikka_operator_versions(id,ciphertext,revision) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET ciphertext=excluded.ciphertext,revision=excluded.revision")
        .bind(id).bind(box_.seal(&aad,key.as_bytes())).bind(&version).execute(&mut *tx).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    Ok(version)
}
// A personal alias must not price an expensive model as its cheaper canonical
// name. Operators attest template aliases; other targets need catalog metadata.
fn priced_model<'a>(
    config: &'a Config,
    template: &Template,
    canonical: &'a Model,
    provider: &str,
) -> Result<&'a Model, Error> {
    if provider == canonical.provider_model_id
        || mapping(
            &template.model_mapping,
            &canonical.id,
            &canonical.provider_model_id,
        )?
        .as_deref()
            == Some(provider)
    {
        return Ok(canonical);
    }
    config
        .catalog
        .iter()
        .find(|m| m.provider_model_id == provider)
        .ok_or_else(bad)
}
pub async fn snapshot(s: &AppState, u: &str) -> Result<Value, Error> {
    let r = configured(s)?;
    let personal = personal(s, u).await?;
    let mut templates: Vec<_> = r.config.connections.iter().collect();
    templates.sort_by_key(|t| t.priority);
    let mut routes = serde_json::Map::new();
    for (role, id) in roles(s, u, r).await? {
        if id.starts_with("subscription/") {
            routes.insert(role, super::subscriptions::route(s, u, &id).await?);
            continue;
        }
        let m = r
            .config
            .catalog
            .iter()
            .find(|m| m.id == id)
            .ok_or_else(bad)?;
        let mut selected = None;
        for p in &personal {
            if !p.active {
                continue;
            }
            let Some(t) = templates.iter().find(|t| t.id == p.template_id && t.active) else {
                continue;
            };
            let rules = if p
                .model_mapping
                .lines()
                .all(|line| line.split('#').next().unwrap().trim().is_empty())
            {
                &t.model_mapping
            } else {
                &p.model_mapping
            };
            if let Some(provider) = mapping(rules, &id, &m.provider_model_id)? {
                if r.secret_box
                    .as_ref()
                    .and_then(|b| b.open(&format!("kikka:{u}:{}", p.id), &p.ciphertext))
                    .is_none()
                {
                    return Err(bad());
                }
                selected = Some((
                    priced_model(&r.config, t, m, &provider)?,
                    provider,
                    p.id.clone(),
                    revision(r, t, &personal_version(p)),
                    t.endpoint.clone(),
                    "you",
                ));
                break;
            }
        }
        if selected.is_none() {
            for t in &templates {
                if !t.active {
                    continue;
                }
                if let Some(provider) = mapping(&t.model_mapping, &id, &m.provider_model_id)? {
                    let Some(key) = r.keys.get(&t.id) else {
                        return Err(bad());
                    };
                    let v = operator_version(s, &t.id, key).await?;
                    selected = Some((
                        m,
                        provider,
                        t.id.clone(),
                        revision(r, t, &v),
                        t.endpoint.clone(),
                        "ohiyo",
                    ));
                    break;
                }
            }
        }
        if let Some((m, provider, connection, revision, endpoint, funded)) = selected {
            routes.insert(role,json!({"canonicalModel":id,"providerModelId":provider,"connectionId":connection,"connectionRevision":revision,"fundedBy":funded,"endpoint":endpoint,"contextWindow":m.context_window,"maxOutputTokens":m.max_output_tokens,"inputUsdPerMillion":m.input_usd_per_million,"outputUsdPerMillion":m.output_usd_per_million}));
        }
    }
    Ok(Value::Object(routes))
}
pub async fn get(
    State(s): State<AppState>,
    AuthUser(u, _): AuthUser,
) -> Result<Json<Value>, Error> {
    let Ok(r) = configured(&s) else {
        return Ok(Json(
            json!({"catalog":[],"roles":{},"connections":[],"preview":{},"disabledReason":"Model routing is not configured."}),
        ));
    };
    let mut catalog: Vec<Value> = r.config.catalog.iter().map(|m| json!(m)).collect();
    catalog.extend(super::subscriptions::catalog(&s, &u).await);
    if catalog.is_empty() {
        return Err((
            StatusCode::SERVICE_UNAVAILABLE,
            "Model routing is unavailable.".into(),
        ));
    }
    let mut connections = Vec::new();
    for p in personal(&s, &u).await? {
        connections.push(json!({"id":p.id,"name":p.name,"templateId":p.template_id,"modelMapping":p.model_mapping,"active":p.active,"priority":p.priority,"scope":"personal","hasKey":!p.ciphertext.is_empty()}));
    }
    let mut templates: Vec<_> = r.config.connections.iter().collect();
    templates.sort_by_key(|t| t.priority);
    for (priority, t) in templates.iter().enumerate() {
        connections.push(json!({"id":t.id,"name":t.name,"templateId":t.id,"modelMapping":t.model_mapping,"active":t.active,"priority":priority,"scope":"ohiyo","hasKey":r.keys.contains_key(&t.id)}));
    }
    Ok(Json(
        json!({"catalog":catalog,"roles":roles(&s,&u,r).await?,"connections":connections,"preview":snapshot(&s,&u).await.unwrap_or(json!({}))}),
    ))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RoleUpdate {
    general: String,
    research: String,
    review: String,
    summary: String,
}
pub async fn put_roles(
    State(s): State<AppState>,
    AuthUser(u, _): AuthUser,
    Json(body): Json<RoleUpdate>,
) -> Result<Json<Value>, Error> {
    let _guard = s.instance_lifecycle.lock().await;
    let r = configured(&s)?;
    let body: BTreeMap<String, String> = BTreeMap::from([
        ("general".into(), body.general),
        ("research".into(), body.research),
        ("review".into(), body.review),
        ("summary".into(), body.summary),
    ]);
    for model in body.values() {
        if model.starts_with("subscription/") {
            super::subscriptions::route(&s, &u, model).await?;
        } else if !r.config.catalog.iter().any(|m| &m.id == model) {
            return Err(bad());
        }
    }
    sqlx::query("INSERT INTO kikka_roles(owner,roles) VALUES(?,?) ON CONFLICT(owner) DO UPDATE SET roles=excluded.roles").bind(&u).bind(json!(body).to_string()).execute(&s.db).await.map_err(internal)?;
    get(State(s.clone()), AuthUser(u, 0)).await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Upsert {
    id: Option<String>,
    name: String,
    template_id: String,
    model_mapping: String,
    active: bool,
    priority: usize,
    key: Option<String>,
}
pub async fn upsert(
    State(s): State<AppState>,
    AuthUser(u, _): AuthUser,
    Json(b): Json<Upsert>,
) -> Result<Json<Value>, Error> {
    let _guard = s.instance_lifecycle.lock().await;
    let r = configured(&s)?;
    let box_ = r.secret_box.as_ref().ok_or_else(bad)?;
    if !short(&b.name, 100)
        || !r.config.connections.iter().any(|t| t.id == b.template_id)
        || b.id.as_ref().is_some_and(|id| !short(id, 100))
        || b.priority > 50
    {
        return Err(bad());
    }
    mapping(&b.model_mapping, "", "")?;
    let template = r
        .config
        .connections
        .iter()
        .find(|t| t.id == b.template_id)
        .ok_or_else(bad)?;
    for m in &r.config.catalog {
        if let Some(provider) = mapping(&b.model_mapping, &m.id, &m.provider_model_id)? {
            priced_model(&r.config, template, m, &provider)?;
        }
    }
    let rows = personal(&s, &u).await?;
    let old =
        b.id.as_ref()
            .and_then(|id| rows.iter().find(|p| &p.id == id));
    if b.id.is_some() && old.is_none() {
        return Err(bad());
    }
    if old.is_none() && rows.len() >= 50 {
        return Err(bad());
    }
    let id = b.id.clone().unwrap_or_else(crate::types::new_id);
    let aad = format!("kikka:{u}:{id}");
    let ciphertext = match b.key.as_deref().filter(|k| !k.trim().is_empty()) {
        Some(k) => {
            if !short(k, 4096) {
                return Err(bad());
            }
            box_.seal(&aad, k.as_bytes())
        }
        None => old.map(|p| p.ciphertext.clone()).ok_or_else(bad)?,
    };
    let mut order: Vec<_> = rows
        .iter()
        .filter(|p| p.id != id)
        .map(|p| p.id.clone())
        .collect();
    order.insert(b.priority.min(order.len()), id.clone());
    let mut tx = s.db.begin().await.map_err(internal)?;
    sqlx::query("INSERT INTO kikka_connections(id,owner,name,template_id,model_mapping,active,priority,ciphertext,revision) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,template_id=excluded.template_id,model_mapping=excluded.model_mapping,active=excluded.active,ciphertext=excluded.ciphertext,revision=excluded.revision")
 .bind(&id).bind(&u).bind(b.name).bind(b.template_id).bind(b.model_mapping).bind(b.active).bind(0).bind(ciphertext).bind(crate::types::new_id()).execute(&mut *tx).await.map_err(internal)?;
    for (n, id) in order.iter().enumerate() {
        sqlx::query("UPDATE kikka_connections SET priority=? WHERE id=? AND owner=?")
            .bind(n as i64)
            .bind(id)
            .bind(&u)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
    }
    tx.commit().await.map_err(internal)?;
    get(State(s.clone()), AuthUser(u, 0)).await
}
pub async fn delete(
    State(s): State<AppState>,
    AuthUser(u, _): AuthUser,
    Path(id): Path<String>,
) -> Result<Json<Value>, Error> {
    let _guard = s.instance_lifecycle.lock().await;
    let mut tx = s.db.begin().await.map_err(internal)?;
    let changed = sqlx::query("DELETE FROM kikka_connections WHERE owner=? AND id=?")
        .bind(&u)
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(internal)?
        .rows_affected();
    if changed != 1 {
        return Err(bad());
    }
    let ids: Vec<String> =
        sqlx::query_scalar("SELECT id FROM kikka_connections WHERE owner=? ORDER BY priority,id")
            .bind(&u)
            .fetch_all(&mut *tx)
            .await
            .map_err(internal)?;
    for (n, id) in ids.iter().enumerate() {
        sqlx::query("UPDATE kikka_connections SET priority=? WHERE id=?")
            .bind(n as i64)
            .bind(id)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
    }
    tx.commit().await.map_err(internal)?;
    get(State(s.clone()), AuthUser(u, 0)).await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Access {
    owner: String,
    task: String,
    #[serde(rename = "root_goal")]
    root_goal: String,
    role: String,
    connection_id: String,
}
pub async fn access(
    State(s): State<AppState>,
    headers: HeaderMap,
    Json(b): Json<Access>,
) -> Result<impl axum::response::IntoResponse, Error> {
    let _guard = s.instance_lifecycle.lock().await;
    let k = s.kikka.as_ref().ok_or_else(bad)?;
    let pi = k.pi.as_ref().ok_or_else(bad)?;
    let supplied = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or("");
    let mut mac = Hmac::<Sha256>::new_from_slice(pi.token.as_bytes()).map_err(|_| bad())?;
    mac.update(supplied.as_bytes());
    let tag = mac.finalize().into_bytes();
    let mut expected = Hmac::<Sha256>::new_from_slice(pi.token.as_bytes()).map_err(|_| bad())?;
    expected.update(pi.token.as_bytes());
    if expected.verify_slice(&tag).is_err() {
        return Err((StatusCode::UNAUTHORIZED, "Unauthorized.".into()));
    }
    if k.user != "*" && k.user != b.owner {
        return Err(bad());
    }
    let saved:Option<String>=sqlx::query_scalar("SELECT r.routing FROM burrow_agent_runs r JOIN burrow_tasks t ON t.id=r.task_id JOIN users u ON u.id=t.user_id WHERE t.user_id=? AND t.id=? AND r.root_goal=?").bind(&b.owner).bind(&b.task).bind(&b.root_goal).fetch_optional(&s.db).await.map_err(internal)?.flatten();
    let saved: Value = serde_json::from_str(&saved.ok_or_else(bad)?).map_err(|_| bad())?;
    let pinned = &saved[&b.role];
    if pinned.is_null() || pinned["connectionId"] != b.connection_id {
        return Err(bad());
    }
    if pinned["canonicalModel"]
        .as_str()
        .is_some_and(|id| id.starts_with("subscription/"))
    {
        let current = super::subscriptions::route(
            &s,
            &b.owner,
            pinned["canonicalModel"].as_str().ok_or_else(bad)?,
        )
        .await?;
        if !same_snapshot(Some(pinned), Some(&current)) {
            return Err(bad());
        }
        return Ok((
            [("Cache-Control", "no-store")],
            Json(json!({"key":"subscription-authorized"})),
        ));
    }
    let r = configured(&s)?;
    let key = if pinned["fundedBy"] == "you" {
        let rows = personal(&s, &b.owner).await?;
        let p = rows
            .iter()
            .find(|p| p.id == b.connection_id && p.active)
            .ok_or_else(bad)?;
        let t = r
            .config
            .connections
            .iter()
            .find(|t| t.id == p.template_id && t.active)
            .ok_or_else(bad)?;
        if pinned["connectionRevision"] != revision(r, t, &personal_version(p)) {
            return Err(bad());
        }
        String::from_utf8(
            r.secret_box
                .as_ref()
                .ok_or_else(bad)?
                .open(&format!("kikka:{}:{}", b.owner, p.id), &p.ciphertext)
                .ok_or_else(bad)?,
        )
        .map_err(|_| bad())?
    } else {
        let t = r
            .config
            .connections
            .iter()
            .find(|t| t.id == b.connection_id && t.active)
            .ok_or_else(bad)?;
        let key = r.keys.get(&t.id).ok_or_else(bad)?;
        let v = operator_version(&s, &t.id, key).await?;
        if pinned["connectionRevision"] != revision(r, t, &v) {
            return Err(bad());
        }
        key.clone()
    };
    Ok(([("Cache-Control", "no-store")], Json(json!({"key":key}))))
}
