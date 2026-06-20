use axum::{
    extract::{Multipart, Path as AxumPath, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Duration,
};
use tokio::{io::AsyncWriteExt, process::Command, time::timeout};

use crate::{
    auth::AuthUser,
    gateway::broadcast_to_server,
    import::{
        self,
        discrawl::{self, DiscrawlPreview, DiscrawlReadOptions},
        model::{HistoryWindow, ImportOptions},
        report::ImportReport,
    },
    types::{new_id, GatewayEvent, ServerWithChannels},
    AppState,
};

const IMPORT_UPLOAD_DIR: &str = "import-uploads/discord";
const MANAGED_IMPORT_DIR: &str = "import-uploads/managed-discord";
const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";
const DEFAULT_MAX_DISCRAWL_DB_UPLOAD_BYTES: i64 = 2 * 1024 * 1024 * 1024; // 2 GiB
const DEFAULT_DISCORD_BOT_PERMISSIONS: &str = "66560"; // View Channels + Read Message History
const MANAGED_DISCRAWL_TIMEOUT_SECS: u64 = 60 * 60 * 4;

#[derive(Debug, Deserialize)]
pub struct DiscrawlArchiveBody {
    /// Path on the server host to Discrawl's SQLite archive. This endpoint is gated
    /// behind `OHIYO_ENABLE_LOCAL_DISCRAWL_IMPORT=1` because arbitrary host paths are
    /// appropriate for local/admin import tooling, not public multi-tenant traffic.
    pub db_path: String,
    /// Optional base directory for downloaded Discrawl media. Relative
    /// `message_attachments.media_path` values are resolved against this directory.
    pub media_root: Option<String>,
    /// Optional Discord guild snowflake. If omitted, the first non-`@me` guild is used.
    pub guild_id: Option<String>,
    pub history: Option<HistoryWindow>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DiscrawlImportResponse {
    pub server: ServerWithChannels,
    pub report: ImportReport,
}

#[derive(Debug, Serialize)]
pub struct DiscrawlImportCapability {
    pub enabled: bool,
    pub managed_enabled: bool,
    pub mode: &'static str,
    pub message: &'static str,
}

#[derive(Debug, Serialize)]
pub struct DiscordConnectInfo {
    pub managed_enabled: bool,
    pub invite_url: Option<String>,
    pub message: String,
}

#[derive(Debug, Serialize)]
pub struct DiscordGuildInfo {
    pub id: String,
    pub name: String,
    pub icon_url: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
pub struct ManagedDiscordImportBody {
    pub guild_id: String,
    pub history: Option<HistoryWindow>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ManagedDiscordImportJobState {
    Queued,
    Running,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct ManagedDiscordImportJob {
    pub id: String,
    pub state: ManagedDiscordImportJobState,
    pub stage: String,
    pub message: String,
    pub result: Option<DiscrawlImportResponse>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
pub struct ManagedDiscordImportJobStartResponse {
    pub job: ManagedDiscordImportJob,
}

#[derive(Debug, Serialize)]
pub struct DiscrawlArchiveUploadResponse {
    pub db_path: String,
    pub filename: String,
    pub size_bytes: i64,
}

pub async fn discrawl_import_capability(
    _auth: AuthUser,
) -> Result<Json<DiscrawlImportCapability>, (StatusCode, String)> {
    let enabled = local_discrawl_import_enabled();
    let managed_enabled = managed_discord_import_enabled();
    Ok(Json(DiscrawlImportCapability {
        enabled,
        managed_enabled,
        mode: if managed_enabled {
            "managed_discord_connect"
        } else {
            "local_discrawl_archive"
        },
        message: if managed_enabled {
            "This home can connect to Discord and clone a server directly."
        } else if enabled {
            "This home can import a local Discrawl SQLite archive."
        } else {
            "Discord import is disabled on this home. Enable managed import or local Discrawl archive import on the server."
        },
    }))
}

pub async fn discord_connect_info(
    _auth: AuthUser,
) -> Result<Json<DiscordConnectInfo>, (StatusCode, String)> {
    let managed_enabled = managed_discord_import_enabled();
    Ok(Json(DiscordConnectInfo {
        managed_enabled,
        invite_url: discord_bot_invite_url(),
        message: if managed_enabled {
            "Add the Ohiyo bot to your Discord server, then return here to clone it.".to_owned()
        } else {
            "Managed Discord clone is not configured on this home yet.".to_owned()
        },
    }))
}

pub async fn list_discord_guilds(
    _auth: AuthUser,
) -> Result<Json<Vec<DiscordGuildInfo>>, (StatusCode, String)> {
    require_managed_discord_import_enabled()?;
    let guilds = fetch_bot_guilds().await?;
    Ok(Json(guilds))
}

pub async fn start_managed_discord_import_job(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<ManagedDiscordImportBody>,
) -> Result<Json<ManagedDiscordImportJobStartResponse>, (StatusCode, String)> {
    require_managed_discord_import_enabled()?;
    let guild_id = validate_guild_id(&body.guild_id)?;
    let history = body.history.unwrap_or(HistoryWindow::All);
    let job_id = new_id();
    let job = ManagedDiscordImportJob {
        id: job_id.clone(),
        state: ManagedDiscordImportJobState::Queued,
        stage: "queued".to_owned(),
        message: "Queued — Ohiyo is getting ready to clone your server.".to_owned(),
        result: None,
        error: None,
        created_at: now_ts(),
        updated_at: now_ts(),
    };
    upsert_import_job(&auth.0, job.clone());

    let owner_id = auth.0.clone();
    tokio::spawn(async move {
        update_import_job(&owner_id, &job_id, |job| {
            job.state = ManagedDiscordImportJobState::Running;
            job.stage = "connecting".to_owned();
            job.message = "Connecting to Discord and reading your server…".to_owned();
        });
        let result = run_managed_discord_import_inner(
            owner_id.clone(),
            state,
            guild_id,
            history,
            |stage, message| {
                update_import_job(&owner_id, &job_id, |job| {
                    job.state = ManagedDiscordImportJobState::Running;
                    job.stage = stage.to_owned();
                    job.message = message.to_owned();
                });
            },
        )
        .await;
        match result {
            Ok(response) => update_import_job(&owner_id, &job_id, |job| {
                job.state = ManagedDiscordImportJobState::Succeeded;
                job.stage = "done".to_owned();
                job.message = "Done — your Ohiyo space is ready.".to_owned();
                job.result = Some(response);
                job.error = None;
            }),
            Err((_status, message)) => update_import_job(&owner_id, &job_id, |job| {
                job.state = ManagedDiscordImportJobState::Failed;
                job.stage = "failed".to_owned();
                job.message = "Discord clone failed.".to_owned();
                job.error = Some(message);
            }),
        }
    });

    Ok(Json(ManagedDiscordImportJobStartResponse { job }))
}

pub async fn get_managed_discord_import_job(
    auth: AuthUser,
    AxumPath(job_id): AxumPath<String>,
) -> Result<Json<ManagedDiscordImportJob>, (StatusCode, String)> {
    get_import_job(&auth.0, &job_id)
        .map(Json)
        .ok_or((StatusCode::NOT_FOUND, "import job not found".to_owned()))
}

pub async fn upload_discrawl_archive(
    auth: AuthUser,
    mut multipart: Multipart,
) -> Result<Json<DiscrawlArchiveUploadResponse>, (StatusCode, String)> {
    require_local_discrawl_import_enabled()?;
    tokio::fs::create_dir_all(IMPORT_UPLOAD_DIR)
        .await
        .map_err(crate::api::error::internal)?;

    let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
    else {
        return Err((StatusCode::BAD_REQUEST, "archive file required".into()));
    };

    let filename = field
        .file_name()
        .map(str::to_owned)
        .unwrap_or_else(|| "discrawl.db".to_owned());
    validate_db_filename(&filename)?;

    let safe_filename = safe_filename(&filename);
    let tmp_path = PathBuf::from(IMPORT_UPLOAD_DIR).join(format!("tmp-{}", new_id()));
    let final_path = PathBuf::from(IMPORT_UPLOAD_DIR).join(format!(
        "{}-{}-{}",
        safe_filename_stem(&auth.0),
        new_id(),
        safe_filename
    ));
    let mut tmp_file = tokio::fs::File::create(&tmp_path)
        .await
        .map_err(crate::api::error::internal)?;

    let max_bytes = max_discrawl_db_upload_bytes();
    let mut size_bytes: i64 = 0;
    let mut header = Vec::with_capacity(SQLITE_MAGIC.len());

    while let Some(chunk) = field
        .chunk()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()))?
    {
        size_bytes += chunk.len() as i64;
        if size_bytes > max_bytes {
            cleanup_tmp(&tmp_path).await;
            return Err((
                StatusCode::PAYLOAD_TOO_LARGE,
                "Discrawl archive upload is too large".into(),
            ));
        }
        if header.len() < SQLITE_MAGIC.len() {
            let take = (SQLITE_MAGIC.len() - header.len()).min(chunk.len());
            header.extend_from_slice(&chunk[..take]);
        }
        tmp_file
            .write_all(&chunk)
            .await
            .map_err(crate::api::error::internal)?;
    }
    tmp_file.flush().await.ok();
    drop(tmp_file);

    if header.as_slice() != SQLITE_MAGIC {
        cleanup_tmp(&tmp_path).await;
        return Err((
            StatusCode::BAD_REQUEST,
            "uploaded file is not a SQLite database".into(),
        ));
    }

    tokio::fs::rename(&tmp_path, &final_path)
        .await
        .map_err(crate::api::error::internal)?;

    Ok(Json(DiscrawlArchiveUploadResponse {
        db_path: final_path.to_string_lossy().to_string(),
        filename,
        size_bytes,
    }))
}

pub async fn run_managed_discord_import(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<ManagedDiscordImportBody>,
) -> Result<Json<DiscrawlImportResponse>, (StatusCode, String)> {
    require_managed_discord_import_enabled()?;
    let guild_id = validate_guild_id(&body.guild_id)?;
    let history = body.history.unwrap_or(HistoryWindow::All);
    run_managed_discord_import_inner(auth.0, state, guild_id, history, |_, _| {})
        .await
        .map(Json)
}

async fn run_managed_discord_import_inner(
    owner_id: String,
    state: AppState,
    guild_id: String,
    history: HistoryWindow,
    progress: impl Fn(&str, &str) + Send + Sync,
) -> Result<DiscrawlImportResponse, (StatusCode, String)> {
    let archive = run_discrawl_job(&guild_id, history, &progress).await?;

    progress("reading_archive", "Reading the cloned Discord archive…");
    let guild = discrawl::read_source_guild(
        &archive.db_path,
        DiscrawlReadOptions {
            guild_id: Some(guild_id.clone()),
            media_root: Some(archive.media_root.clone()),
        },
    )
    .await
    .map_err(crate::api::error::internal)?;
    let opts = ImportOptions { history };
    progress(
        "importing",
        "Creating channels, messages, authors, and attachments in Ohiyo…",
    );
    let (server_id, report) = import::run_import(&state.db, &owner_id, &guild, opts)
        .await
        .map_err(crate::api::error::internal)?;
    progress("opening_space", "Opening your new Ohiyo space…");
    let server = crate::api::servers::fetch_full(&server_id, &state).await?;
    cleanup_managed_job_dir(&archive.job_dir).await;
    broadcast_to_server(
        &state,
        &server.server.id,
        &GatewayEvent::ServerCreate(server.clone()),
    )
    .await;
    Ok(DiscrawlImportResponse { server, report })
}

pub async fn preview_discrawl_import(
    _auth: AuthUser,
    State(_state): State<AppState>,
    Json(body): Json<DiscrawlArchiveBody>,
) -> Result<Json<DiscrawlPreview>, (StatusCode, String)> {
    require_local_discrawl_import_enabled()?;
    validate_db_path(&body.db_path)?;
    let preview = discrawl::preview(&body.db_path, read_opts(&body))
        .await
        .map_err(crate::api::error::internal)?;
    Ok(Json(preview))
}

pub async fn run_discrawl_import(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<DiscrawlArchiveBody>,
) -> Result<Json<DiscrawlImportResponse>, (StatusCode, String)> {
    require_local_discrawl_import_enabled()?;
    validate_db_path(&body.db_path)?;
    let guild = discrawl::read_source_guild(&body.db_path, read_opts(&body))
        .await
        .map_err(crate::api::error::internal)?;
    let opts = ImportOptions {
        history: body.history.unwrap_or(HistoryWindow::All),
    };
    let (server_id, report) = import::run_import(&state.db, &auth.0, &guild, opts)
        .await
        .map_err(crate::api::error::internal)?;
    let server = crate::api::servers::fetch_full(&server_id, &state).await?;
    cleanup_uploaded_archive_if_staged(&body.db_path).await;
    broadcast_to_server(
        &state,
        &server.server.id,
        &GatewayEvent::ServerCreate(server.clone()),
    )
    .await;
    Ok(Json(DiscrawlImportResponse { server, report }))
}

fn read_opts(body: &DiscrawlArchiveBody) -> DiscrawlReadOptions {
    DiscrawlReadOptions {
        guild_id: body.guild_id.clone(),
        media_root: body.media_root.as_ref().map(PathBuf::from),
    }
}

fn now_ts() -> i64 {
    chrono::Utc::now().timestamp()
}

type ImportJobStore = HashMap<String, HashMap<String, ManagedDiscordImportJob>>;

fn import_jobs() -> &'static Mutex<ImportJobStore> {
    static JOBS: OnceLock<Mutex<ImportJobStore>> = OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn upsert_import_job(owner_id: &str, job: ManagedDiscordImportJob) {
    let mut jobs = import_jobs().lock().expect("import job store poisoned");
    jobs.entry(owner_id.to_owned())
        .or_default()
        .insert(job.id.clone(), job);
}

fn update_import_job(
    owner_id: &str,
    job_id: &str,
    update: impl FnOnce(&mut ManagedDiscordImportJob),
) {
    let mut jobs = import_jobs().lock().expect("import job store poisoned");
    let Some(job) = jobs
        .get_mut(owner_id)
        .and_then(|owner_jobs| owner_jobs.get_mut(job_id))
    else {
        return;
    };
    update(job);
    job.updated_at = now_ts();
}

fn get_import_job(owner_id: &str, job_id: &str) -> Option<ManagedDiscordImportJob> {
    let jobs = import_jobs().lock().expect("import job store poisoned");
    jobs.get(owner_id)
        .and_then(|owner_jobs| owner_jobs.get(job_id))
        .cloned()
}

#[derive(Debug, Deserialize)]
struct DiscordApiGuild {
    id: String,
    name: String,
    icon: Option<String>,
}

async fn fetch_bot_guilds() -> Result<Vec<DiscordGuildInfo>, (StatusCode, String)> {
    let token = std::env::var("DISCORD_BOT_TOKEN").map_err(|_| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "Discord bot token is not configured on this Ohiyo home".to_owned(),
        )
    })?;
    let response = reqwest::Client::new()
        .get("https://discord.com/api/v10/users/@me/guilds?limit=200")
        .header("Authorization", format!("Bot {token}"))
        .send()
        .await
        .map_err(crate::api::error::internal)?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        tracing::warn!(%status, body = %text, "Discord guild list request failed");
        return Err((
            StatusCode::BAD_GATEWAY,
            "Could not ask Discord which servers the Ohiyo bot can see".into(),
        ));
    }
    let guilds: Vec<DiscordApiGuild> =
        response.json().await.map_err(crate::api::error::internal)?;
    Ok(guilds
        .into_iter()
        .map(|guild| DiscordGuildInfo {
            icon_url: guild.icon.as_ref().map(|icon| {
                format!(
                    "https://cdn.discordapp.com/icons/{}/{}.png?size=64",
                    guild.id, icon
                )
            }),
            id: guild.id,
            name: guild.name,
        })
        .collect())
}

struct ManagedDiscrawlArchive {
    job_dir: PathBuf,
    db_path: PathBuf,
    media_root: PathBuf,
}

async fn run_discrawl_job(
    guild_id: &str,
    history: HistoryWindow,
    progress: &(impl Fn(&str, &str) + Send + Sync),
) -> Result<ManagedDiscrawlArchive, (StatusCode, String)> {
    let job_dir = PathBuf::from(MANAGED_IMPORT_DIR).join(new_id());
    let config_home = job_dir.join("config");
    let data_home = job_dir.join("data");
    let cache_home = job_dir.join("cache");
    tokio::fs::create_dir_all(&config_home)
        .await
        .map_err(crate::api::error::internal)?;
    tokio::fs::create_dir_all(&data_home)
        .await
        .map_err(crate::api::error::internal)?;
    tokio::fs::create_dir_all(&cache_home)
        .await
        .map_err(crate::api::error::internal)?;

    progress("preparing", "Preparing the Discord clone workspace…");
    run_discrawl_command(
        &job_dir,
        &["init", "--guild", guild_id],
        &config_home,
        &data_home,
        &cache_home,
    )
    .await?;

    let since;
    let mut sync_args = vec![
        "sync",
        "--source",
        "discord",
        "--guild",
        guild_id,
        "--full",
        "--with-media",
    ];
    if matches!(history, HistoryWindow::Last90Days) {
        let cutoff = chrono::Utc::now() - chrono::Duration::days(90);
        since = cutoff.to_rfc3339();
        sync_args.push("--since");
        sync_args.push(&since);
    }
    progress(
        "syncing_discord",
        "Copying channels, messages, and attachments from Discord…",
    );
    run_discrawl_command(&job_dir, &sync_args, &config_home, &data_home, &cache_home).await?;

    Ok(ManagedDiscrawlArchive {
        job_dir,
        db_path: data_home.join("discrawl").join("discrawl.db"),
        media_root: cache_home.join("discrawl").join("media"),
    })
}

async fn run_discrawl_command(
    job_dir: &Path,
    args: &[&str],
    config_home: &Path,
    data_home: &Path,
    cache_home: &Path,
) -> Result<(), (StatusCode, String)> {
    let token = std::env::var("DISCORD_BOT_TOKEN").map_err(|_| {
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "Discord bot token is not configured on this Ohiyo home".to_owned(),
        )
    })?;
    let output = timeout(
        Duration::from_secs(MANAGED_DISCRAWL_TIMEOUT_SECS),
        Command::new(discrawl_bin())
            .args(args)
            .env("DISCORD_BOT_TOKEN", token)
            .env("XDG_CONFIG_HOME", config_home)
            .env("XDG_DATA_HOME", data_home)
            .env("XDG_CACHE_HOME", cache_home)
            .env("DISCRAWL_NO_UPDATE_CHECK", "1")
            .current_dir(job_dir)
            .output(),
    )
    .await
    .map_err(|_| {
        (
            StatusCode::GATEWAY_TIMEOUT,
            "Discord clone took too long; try Last 90 days first".to_owned(),
        )
    })?
    .map_err(crate::api::error::internal)?;

    if output.status.success() {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    tracing::warn!(
        args = ?args,
        status = ?output.status.code(),
        stderr = %stderr,
        stdout = %stdout,
        "managed Discrawl command failed"
    );
    Err((
        StatusCode::BAD_GATEWAY,
        concise_discrawl_error(&stderr, &stdout),
    ))
}

fn concise_discrawl_error(stderr: &str, stdout: &str) -> String {
    let text = if stderr.trim().is_empty() {
        stdout
    } else {
        stderr
    };
    let line = text
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("Discrawl failed");
    format!("Discord clone failed: {}", line.trim())
}

fn discrawl_bin() -> String {
    std::env::var("OHIYO_DISCRAWL_BIN").unwrap_or_else(|_| "discrawl".to_owned())
}

async fn cleanup_managed_job_dir(path: &Path) {
    let Ok(root) = tokio::fs::canonicalize(MANAGED_IMPORT_DIR).await else {
        return;
    };
    let Ok(job) = tokio::fs::canonicalize(path).await else {
        return;
    };
    if job.starts_with(root) {
        tokio::fs::remove_dir_all(job).await.ok();
    }
}

fn max_discrawl_db_upload_bytes() -> i64 {
    std::env::var("OHIYO_MAX_DISCRAWL_DB_UPLOAD_BYTES")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(DEFAULT_MAX_DISCRAWL_DB_UPLOAD_BYTES)
}

async fn cleanup_tmp(path: &Path) {
    tokio::fs::remove_file(path).await.ok();
}

async fn cleanup_uploaded_archive_if_staged(path: &str) {
    let archive = Path::new(path);
    let Ok(upload_dir) = tokio::fs::canonicalize(IMPORT_UPLOAD_DIR).await else {
        return;
    };
    let Ok(archive_path) = tokio::fs::canonicalize(archive).await else {
        return;
    };
    if !archive_path.starts_with(&upload_dir) {
        return;
    }
    if let Err(err) = tokio::fs::remove_file(&archive_path).await {
        tracing::warn!(
            error = %err,
            path = %archive_path.display(),
            "failed to delete staged Discrawl archive after import"
        );
    }
}

fn safe_filename(name: &str) -> String {
    let safe: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if safe.trim_matches('_').is_empty() {
        "discrawl.db".to_owned()
    } else {
        safe
    }
}

fn safe_filename_stem(name: &str) -> String {
    safe_filename(name)
        .chars()
        .take(24)
        .collect::<String>()
        .trim_matches('_')
        .to_owned()
}

fn validate_db_filename(filename: &str) -> Result<(), (StatusCode, String)> {
    if filename.ends_with(".db") || filename.ends_with(".sqlite") || filename.ends_with(".sqlite3")
    {
        Ok(())
    } else {
        Err((
            StatusCode::BAD_REQUEST,
            "archive must be a SQLite file (.db/.sqlite/.sqlite3)".into(),
        ))
    }
}

fn managed_discord_import_enabled() -> bool {
    env_truthy("OHIYO_ENABLE_MANAGED_DISCORD_IMPORT")
        && std::env::var("DISCORD_BOT_TOKEN").is_ok()
        && std::env::var("OHIYO_DISCORD_CLIENT_ID").is_ok()
}

fn discord_bot_invite_url() -> Option<String> {
    let client_id = std::env::var("OHIYO_DISCORD_CLIENT_ID").ok()?;
    let permissions = std::env::var("OHIYO_DISCORD_BOT_PERMISSIONS")
        .unwrap_or_else(|_| DEFAULT_DISCORD_BOT_PERMISSIONS.to_owned());
    Some(format!(
        "https://discord.com/oauth2/authorize?client_id={}&permissions={}&scope=bot%20applications.commands",
        urlencoding::encode(&client_id),
        urlencoding::encode(&permissions)
    ))
}

fn local_discrawl_import_enabled() -> bool {
    env_truthy("OHIYO_ENABLE_LOCAL_DISCRAWL_IMPORT")
}

fn env_truthy(key: &str) -> bool {
    matches!(std::env::var(key), Ok(v) if v == "1" || v.eq_ignore_ascii_case("true"))
}

fn require_managed_discord_import_enabled() -> Result<(), (StatusCode, String)> {
    if managed_discord_import_enabled() {
        Ok(())
    } else {
        Err((
            StatusCode::FORBIDDEN,
            "managed Discord clone is not configured on this server".into(),
        ))
    }
}

fn require_local_discrawl_import_enabled() -> Result<(), (StatusCode, String)> {
    if local_discrawl_import_enabled() {
        Ok(())
    } else {
        Err((
            StatusCode::FORBIDDEN,
            "local Discrawl archive import is disabled on this server".into(),
        ))
    }
}

fn validate_guild_id(guild_id: &str) -> Result<String, (StatusCode, String)> {
    let trimmed = guild_id.trim();
    if trimmed.len() < 5 || !trimmed.bytes().all(|b| b.is_ascii_digit()) {
        return Err((
            StatusCode::BAD_REQUEST,
            "Discord server ID must be numeric".into(),
        ));
    }
    Ok(trimmed.to_owned())
}

fn validate_db_path(path: &str) -> Result<(), (StatusCode, String)> {
    if path.trim().is_empty() {
        return Err((StatusCode::BAD_REQUEST, "db_path required".into()));
    }
    if !path.ends_with(".db") && !path.ends_with(".sqlite") && !path.ends_with(".sqlite3") {
        return Err((
            StatusCode::BAD_REQUEST,
            "db_path must point to a SQLite archive (.db/.sqlite/.sqlite3)".into(),
        ));
    }
    Ok(())
}
