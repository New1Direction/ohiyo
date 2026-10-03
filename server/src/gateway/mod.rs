use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, RwLock},
    time::{Duration, Instant},
};

use axum::{
    extract::{
        ws::{close_code, CloseFrame, Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use futures_util::{SinkExt, StreamExt};
use rand::Rng;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;

use crate::{
    auth,
    types::{ClientEvent, GatewayEvent, PublicUser, VoicePeer},
    AppState,
};

#[derive(Deserialize)]
pub struct WsQuery {
    ticket: String,
}

/// Short-lived, single-use gateway tickets so the long-lived JWT never rides in
/// the WebSocket URL (which leaks into proxy/access logs, devtools, referrers).
pub type WsTickets = Arc<Mutex<HashMap<String, WsTicket>>>;
const TICKET_TTL: Duration = Duration::from_secs(30);

/// Who a ticket opens a socket for, and the user's token version when it was issued:
/// "log out everywhere" bumps the version, which voids tickets issued before it.
pub struct WsTicket {
    user_id: String,
    token_version: i64,
    issued: Instant,
}

/// The user's current token version (None if the user is gone).
async fn current_token_version(state: &AppState, user_id: &str) -> sqlx::Result<Option<i64>> {
    sqlx::query_scalar("SELECT token_version FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_optional(&state.db)
        .await
}

pub fn new_ws_tickets() -> WsTickets {
    Arc::new(Mutex::new(HashMap::new()))
}

#[derive(Serialize)]
pub struct WsTicketResponse {
    pub ticket: String,
}

/// POST /api/v1/ws/ticket — exchange the JWT (Authorization header) for a
/// one-time ticket used to open the gateway socket.
pub async fn create_ws_ticket(
    auth::AuthUser(user_id, token_version): auth::AuthUser,
    State(state): State<AppState>,
) -> Result<Json<WsTicketResponse>, (StatusCode, String)> {
    // Stamped with the version of the JWT that asked, not the account's current one:
    // if "log out everywhere" lands after that JWT passed the auth check, the ticket is
    // already stale and is refused on redeem.
    let ticket: String = rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(32)
        .map(char::from)
        .collect();
    let mut tickets = state.tickets.lock().unwrap_or_else(|e| e.into_inner());
    tickets.retain(|_, t| t.issued.elapsed() < TICKET_TTL); // prune expired
    tickets.insert(
        ticket.clone(),
        WsTicket {
            user_id,
            token_version,
            issued: Instant::now(),
        },
    );
    Ok(Json(WsTicketResponse { ticket }))
}

// user_id → (connection_id → sender). A user can be connected from several devices /
// tabs at once (multi-device); EVERY connection receives the user's broadcasts.
pub type SessionMap = Arc<RwLock<HashMap<String, HashMap<u64, broadcast::Sender<GatewayEvent>>>>>;

pub fn new_session_map() -> SessionMap {
    Arc::new(RwLock::new(HashMap::new()))
}

static NEXT_CONN_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
fn next_conn_id() -> u64 {
    NEXT_CONN_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
}

// Map user_id → current activity (rich presence). Ephemeral; cleared on disconnect.
pub type Activities = Arc<RwLock<HashMap<String, crate::types::Activity>>>;

pub fn new_activities() -> Activities {
    Arc::new(RwLock::new(HashMap::new()))
}

// Set of connected user_ids currently idle (client reported no input). Ephemeral.
pub type IdleSet = Arc<RwLock<std::collections::HashSet<String>>>;

pub fn new_idle_set() -> IdleSet {
    Arc::new(RwLock::new(HashSet::new()))
}

// Users with metadata Privacy Mode enabled. This mirrors the persisted prefs blob at
// gateway-connect time and can be updated live via SetPrivacyMode.
pub type PrivacyUsers = Arc<RwLock<HashSet<String>>>;

pub fn new_privacy_users() -> PrivacyUsers {
    Arc::new(RwLock::new(HashSet::new()))
}

fn privacy_enabled(state: &AppState, user_id: &str) -> bool {
    state
        .privacy
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .contains(user_id)
}

/// The user's saved Privacy Mode preference. Each caller decides what a database error
/// means for it.
async fn load_persisted_privacy_mode(state: &AppState, user_id: &str) -> sqlx::Result<bool> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT prefs_json FROM user_prefs WHERE user_id = ?")
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?;
    Ok(row
        .and_then(|(s,)| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.pointer("/privacy/metadataMode").and_then(|b| b.as_bool()))
        .unwrap_or(false))
}

/// Whether a user is in metadata Privacy Mode, for checks outside a live socket (REST):
/// on if switched on live over the gateway, or saved in their prefs — the latter covers
/// users who have not connected since this process started. Fails closed: if the saved
/// preference can't be read, it counts as on, so a transient error never exposes a
/// read cursor or last-seen time.
pub async fn privacy_mode_on(state: &AppState, user_id: &str) -> bool {
    if privacy_enabled(state, user_id) {
        return true;
    }
    load_persisted_privacy_mode(state, user_id)
        .await
        .unwrap_or_else(|e| {
            tracing::warn!("privacy mode lookup failed for {user_id}, treating as on: {e}");
            true
        })
}

fn set_privacy_mode(state: &AppState, user_id: &str, enabled: bool) {
    let mut private = state.privacy.write().unwrap_or_else(|e| e.into_inner());
    if enabled {
        private.insert(user_id.to_string());
    } else {
        private.remove(user_id);
    }
}

// Map channel_id → active watch-party session (synced video). Ephemeral.
pub type WatchSessions = Arc<RwLock<HashMap<String, crate::types::WatchSession>>>;

pub fn new_watch_sessions() -> WatchSessions {
    Arc::new(RwLock::new(HashMap::new()))
}

/// Server-side throttle for typing pings: (user_id, channel_id) → last broadcast.
pub type TypingCooldowns = Arc<RwLock<HashMap<(String, String), Instant>>>;

pub fn new_typing_cooldowns() -> TypingCooldowns {
    Arc::new(RwLock::new(HashMap::new()))
}

/// Minimum gap between typing broadcasts for a single user in one channel.
const TYPING_COOLDOWN: Duration = Duration::from_secs(2);

/// Largest inbound WebSocket text frame we'll parse. axum's HTTP body limit does not
/// cover WS frames, so without this an authed connection could OOM the server with a
/// single huge frame. Every legitimate `ClientEvent` is far smaller (ICE candidates,
/// short metadata); 64 KiB leaves generous headroom.
const MAX_WS_FRAME_BYTES: usize = 65_536;

/// Largest inbound WebSocket message or frame the transport will buffer at all (the
/// default is 64 MiB). Anything bigger fails the read and ends the connection.
const MAX_WS_TRANSPORT_BYTES: usize = 256 * 1024;

/// A socket that sends nothing for this long is presumed half-open and closed. The
/// client heartbeats every 20 s (`HEARTBEAT_MS` in client/src/gateway.ts), but browsers
/// throttle timers in long-hidden tabs to about one per minute, so a backgrounded web
/// client's heartbeats can arrive a minute or more apart. 150 s outlasts two of those.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(150);

/// Most live gateway sockets one user may hold across tabs and devices. A connection
/// over the cap is closed straight away (policy violation) without a Ready.
const MAX_CONNECTIONS_PER_USER: usize = 20;

/// Cap on how many distinct typing-cooldown entries a single user may pin, so one
/// connection can't grow the shared map by spamming many channels.
const MAX_TYPING_CHANNELS_PER_USER: usize = 64;

/// Minimum gap between heartbeat-driven `last_active_at` writes on one connection.
/// The dead-man's switch works in hours, so a minute of resolution costs nothing.
const HEARTBEAT_TOUCH_INTERVAL: Duration = Duration::from_secs(60);

/// A participant currently connected to a voice channel.
#[derive(Clone)]
pub struct VoiceMember {
    pub user: PublicUser,
    pub muted: bool,
    pub video: bool,
    pub screen: bool,
    /// True when the participant joined with no microphone (receive-only).
    pub listen_only: bool,
}

// channel_id → (user_id → VoiceMember)
pub type VoiceRooms = Arc<RwLock<HashMap<String, HashMap<String, VoiceMember>>>>;

pub fn new_voice_rooms() -> VoiceRooms {
    Arc::new(RwLock::new(HashMap::new()))
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────

/// Broadcast to a single user (unicast). Used for WebRTC signaling relay.
pub fn broadcast_to_user(sessions: &SessionMap, user_id: &str, event: &GatewayEvent) {
    let map = sessions.read().unwrap_or_else(|e| e.into_inner());
    if let Some(conns) = map.get(user_id) {
        for tx in conns.values() {
            let _ = tx.send(event.clone());
        }
    }
}

/// Broadcast only to members of a server. Prevents leaking events to outsiders.
pub async fn broadcast_to_server(state: &AppState, server_id: &str, event: &GatewayEvent) {
    let members: Vec<String> =
        sqlx::query_scalar("SELECT user_id FROM server_members WHERE server_id = ?")
            .bind(server_id)
            .fetch_all(&state.db)
            .await
            .unwrap_or_else(|e| {
                tracing::warn!("broadcast_to_server members query failed for {server_id}: {e}");
                Vec::new()
            });
    // Acquire the lock AFTER the await — never hold a std RwLock across .await.
    let map = state.sessions.read().unwrap_or_else(|e| e.into_inner());
    for uid in members {
        if let Some(conns) = map.get(&uid) {
            for tx in conns.values() {
                let _ = tx.send(event.clone());
            }
        }
    }
}

/// Broadcast to everyone who can see a channel: server members for server
/// channels, or DM participants for DMs. This is the correct scope for
/// MessageCreate / MessageDelete / ReactionUpdate / ChannelCreate.
pub async fn broadcast_to_channel(state: &AppState, channel_id: &str, event: &GatewayEvent) {
    // NULL server_id ⇒ DM. Decode the scalar as Option<String> so a NULL becomes
    // None cleanly; decoding into a bare String coerces NULL to Some("") here,
    // which would misroute every DM to the server-members branch (no recipients)
    // and silently drop all DM broadcasts.
    let server_id: Option<String> =
        sqlx::query_scalar::<_, Option<String>>("SELECT server_id FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten()
            .flatten();

    let recipients: Vec<String> = match server_id {
        Some(sid) => {
            let members: Vec<String> =
                sqlx::query_scalar("SELECT user_id FROM server_members WHERE server_id = ?")
                    .bind(sid)
                    .fetch_all(&state.db)
                    .await
                    .unwrap_or_else(|e| {
                        tracing::warn!(
                        "broadcast_to_channel server members query failed for {channel_id}: {e}"
                    );
                        Vec::new()
                    });
            let mut visible = Vec::with_capacity(members.len());
            for uid in members {
                if crate::api::roles::has_channel_perm(
                    state,
                    channel_id,
                    &uid,
                    crate::api::roles::perm::VIEW_CHANNEL,
                )
                .await
                {
                    visible.push(uid);
                }
            }
            visible
        }
        None => sqlx::query_scalar("SELECT user_id FROM dm_participants WHERE channel_id = ?")
            .bind(channel_id)
            .fetch_all(&state.db)
            .await
            .unwrap_or_else(|e| {
                tracing::warn!(
                    "broadcast_to_channel dm participants query failed for {channel_id}: {e}"
                );
                Vec::new()
            }),
    };

    let map = state.sessions.read().unwrap_or_else(|e| e.into_inner());
    for uid in recipients {
        if let Some(conns) = map.get(&uid) {
            for tx in conns.values() {
                let _ = tx.send(event.clone());
            }
        }
    }
}

// ── WebSocket handler ─────────────────────────────────────────────────────────

/// WebSocket upgrade handler — token is passed as `?token=...` because the
/// browser WebSocket API cannot set custom headers.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    Query(q): Query<WsQuery>,
    State(state): State<AppState>,
) -> Response {
    // One-time ticket (consumed on use), so no long-lived token sits in the URL.
    let ticket = {
        let mut tickets = state.tickets.lock().unwrap_or_else(|e| e.into_inner());
        match tickets.remove(&q.ticket) {
            Some(t) if t.issued.elapsed() < TICKET_TTL => t,
            _ => return (StatusCode::UNAUTHORIZED, "Invalid or expired ticket").into_response(),
        }
    };
    // A ticket issued before "log out everywhere" is void: the version has moved on.
    match current_token_version(&state, &ticket.user_id).await {
        Ok(Some(v)) if v == ticket.token_version => {}
        Ok(_) => return (StatusCode::UNAUTHORIZED, "Invalid or expired ticket").into_response(),
        Err(e) => return crate::api::error::internal(e).into_response(),
    }
    let WsTicket {
        user_id,
        token_version,
        ..
    } = ticket;
    ws.max_message_size(MAX_WS_TRANSPORT_BYTES)
        .max_frame_size(MAX_WS_TRANSPORT_BYTES)
        .on_upgrade(move |socket| handle_socket(socket, user_id, token_version, state))
}

/// What happened when a new connection tried to join the session map.
enum Registration {
    /// In the map: broadcasts reach it, and "log out everywhere" will close it.
    Registered,
    /// The user already holds `MAX_CONNECTIONS_PER_USER` sockets.
    AtCap,
    /// The account's token version moved on since the ticket was issued; the connection
    /// was taken back out of the map.
    Revoked,
}

/// Add connection `conn_id` to the user's sessions (multi-device: a user can have many
/// at once), unless the user is at the cap or `token_version` (the version of the
/// ticket that opened it) is no longer current.
async fn register_connection(
    state: &AppState,
    user_id: &str,
    conn_id: u64,
    tx: broadcast::Sender<GatewayEvent>,
    token_version: i64,
) -> Registration {
    {
        // One step under the lock, so racing connects can't overshoot.
        let mut map = state.sessions.write().unwrap_or_else(|e| e.into_inner());
        let conns = map.entry(user_id.to_owned()).or_default();
        if conns.len() >= MAX_CONNECTIONS_PER_USER {
            return Registration::AtCap;
        }
        conns.insert(conn_id, tx);
    }
    // "Log out everywhere" closes the sockets it finds in the map. One that landed after
    // this ticket was redeemed but before the connection joined the map had nothing to
    // close, so check again now that it is in: any later logout will find it.
    match current_token_version(state, user_id).await {
        Ok(Some(v)) if v == token_version => Registration::Registered,
        outcome => {
            if let Err(e) = outcome {
                tracing::warn!("gateway: token version re-check failed for {user_id}: {e}");
            }
            unregister_connection(state, user_id, conn_id);
            Registration::Revoked
        }
    }
}

/// Take connection `conn_id` out of the session map. True if it was the user's last.
fn unregister_connection(state: &AppState, user_id: &str, conn_id: u64) -> bool {
    let mut map = state.sessions.write().unwrap_or_else(|e| e.into_inner());
    if let Some(conns) = map.get_mut(user_id) {
        conns.remove(&conn_id);
        if conns.is_empty() {
            map.remove(user_id);
            true
        } else {
            false
        }
    } else {
        true
    }
}

async fn handle_socket(
    mut socket: WebSocket,
    user_id: String,
    token_version: i64,
    state: AppState,
) {
    // Generous capacity — WebRTC ICE trickle is chatty (dozens of candidates/sec).
    let (tx, mut rx) = broadcast::channel::<GatewayEvent>(1024);

    let conn_id = next_conn_id();
    match register_connection(&state, &user_id, conn_id, tx.clone(), token_version).await {
        Registration::Registered => {}
        Registration::AtCap => {
            let _ = socket
                .send(Message::Close(Some(CloseFrame {
                    code: close_code::POLICY,
                    reason: "too many connections".into(),
                })))
                .await;
            return;
        }
        Registration::Revoked => {
            // Closed the way "log out everywhere" closes a live socket.
            let _ = socket.send(Message::Close(None)).await;
            return;
        }
    }

    // Connecting counts as activity → refresh the dead-man's-switch liveness clock.
    crate::api::users::touch_active(&state.db, &user_id).await;

    // Load persisted Privacy Mode before the first presence fan-out. Otherwise a
    // privacy-mode user would briefly flash online on every reconnect.
    // On a read error the socket starts with Privacy Mode off, as before: failing closed
    // here would hide this user's presence and typing until they reconnect.
    let persisted_privacy = load_persisted_privacy_mode(&state, &user_id)
        .await
        .unwrap_or(false);
    set_privacy_mode(&state, &user_id, persisted_privacy);

    // Load our own public profile once for voice events.
    let me = load_public_user(&state, &user_id).await;

    // Announce presence to the people who can see us, unless Privacy Mode hides it.
    broadcast_presence(&state, &user_id, true).await;

    let (mut ws_tx, mut ws_rx) = socket.split();

    // Send READY payload.
    if let Ok(ready) = build_ready(&user_id, &state).await {
        match serde_json::to_string(&ready) {
            Ok(json) => {
                let _ = ws_tx.send(Message::Text(json.into())).await;
            }
            Err(e) => {
                // A failed Ready serialize must NOT send an empty frame (the client would
                // treat it as a malformed/empty snapshot); log and skip the send instead.
                tracing::warn!("gateway: failed to serialize Ready for {user_id}: {e}");
            }
        }
    }

    // Forward broadcast events to this WS connection. A lagging receiver (slow
    // client during ICE trickle) drops events but must NOT tear down the stream.
    let mut send_task = tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(event) => {
                    let json = match serde_json::to_string(&event) {
                        Ok(j) => j,
                        Err(_) => continue,
                    };
                    if ws_tx.send(Message::Text(json.into())).await.is_err() {
                        break;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!("gateway: receiver lagged, dropped {n} events");
                }
                // This connection's sender left the session map (logout everywhere).
                Err(broadcast::error::RecvError::Closed) => {
                    let _ = ws_tx.send(Message::Close(None)).await;
                    break;
                }
            }
        }
    });

    // Snapshot: tell the just-connected user who's currently online in their servers
    // (and their activity) so presence shows immediately, not just on the next change.
    send_presence_snapshot(&state, &user_id, &tx).await;
    send_voice_snapshot(&state, &user_id, &tx).await;
    // From here the session map holds the only sender, so removing it closes the socket.
    drop(tx);

    // Drain incoming messages: WebRTC signaling, voice state, heartbeats.
    let mut last_heartbeat_touch: Option<Instant> = None;
    loop {
        let msg = tokio::select! {
            // The forwarder only stops once the socket is closed or unwritable.
            _ = &mut send_task => break,
            msg = tokio::time::timeout(state.gateway_idle_timeout, ws_rx.next()) => match msg {
                Ok(Some(Ok(msg))) => msg,
                // Closed, or a read error such as a message over the transport cap.
                Ok(_) => break,
                // Nothing at all for the idle limit: presume the socket is half-open.
                Err(_) => {
                    tracing::debug!("gateway: closing idle connection for {user_id}");
                    break;
                }
            },
        };
        match msg {
            Message::Close(_) => break,
            Message::Text(t) => {
                // Cap inbound frame size before parsing: axum's HTTP body limit does
                // NOT apply to WebSocket frames, so an authed client could otherwise OOM
                // the server with one giant frame. No legitimate client event is large.
                if t.len() > MAX_WS_FRAME_BYTES {
                    tracing::debug!(
                        "gateway: dropping oversized frame ({} bytes) from {user_id}",
                        t.len()
                    );
                    continue;
                }
                match serde_json::from_str::<ClientEvent>(&t) {
                    Ok(ev) => {
                        handle_client_event(
                            ev,
                            &user_id,
                            me.as_ref(),
                            &state,
                            &mut last_heartbeat_touch,
                        )
                        .await
                    }
                    Err(e) => tracing::debug!("gateway: bad client frame from {user_id}: {e}"),
                }
            }
            _ => {}
        }
    }

    send_task.abort();

    // Leave any voice channels we were in, notifying peers.
    cleanup_voice(&state, &user_id, me.as_ref()).await;

    // Unregister THIS connection. Only when the user's last connection drops do we
    // clear activity + announce offline (otherwise closing one device flaps presence).
    let last_connection = unregister_connection(&state, &user_id, conn_id);
    if last_connection {
        state
            .activities
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&user_id);
        state
            .idle
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&user_id);
        broadcast_presence(&state, &user_id, false).await;
    }
}

/// Handle one client→server event. `last_heartbeat_touch` is this connection's
/// throttle for heartbeat-driven `touch_active` writes.
async fn handle_client_event(
    ev: ClientEvent,
    user_id: &str,
    me: Option<&PublicUser>,
    state: &AppState,
    last_heartbeat_touch: &mut Option<Instant>,
) {
    match ev {
        ClientEvent::JoinVoice {
            channel_id,
            muted,
            video,
            listen_only,
        } => {
            let Some(me) = me else { return };

            // Authorize before touching the roster: the user must be able to see this
            // channel. An unauthorized join adds nothing, announces nothing, and never
            // receives the roster / key distribution — it returns silently.
            if !crate::api::messages::user_can_access(state, &channel_id, user_id).await {
                return;
            }

            // Build the roster of peers already present (before adding ourselves),
            // then register ourselves. Single lock, no await inside. Returns None
            // if we're already in this room (duplicate join → ignore, don't
            // re-send the roster which would trigger a second offer wave).
            let roster: Option<Vec<VoicePeer>> = {
                let mut rooms = state.voice.write().unwrap_or_else(|e| e.into_inner());
                let room = rooms.entry(channel_id.clone()).or_default();
                if room.contains_key(user_id) {
                    None
                } else {
                    let peers = room
                        .iter()
                        .map(|(uid, m)| VoicePeer {
                            user_id: uid.clone(),
                            user: m.user.clone(),
                            muted: m.muted,
                            video: m.video,
                            screen: m.screen,
                            listen_only: m.listen_only,
                        })
                        .collect();
                    room.insert(
                        user_id.to_string(),
                        VoiceMember {
                            user: me.clone(),
                            muted,
                            video,
                            screen: false,
                            listen_only,
                        },
                    );
                    Some(peers)
                }
            };
            let Some(roster) = roster else { return };

            // Tell the joiner who is already here (they will initiate offers).
            broadcast_to_user(
                &state.sessions,
                user_id,
                &GatewayEvent::VoiceRoster {
                    channel_id: channel_id.clone(),
                    peers: roster,
                },
            );

            // Tell everyone who can see the channel that we're in voice, including
            // people who have not joined yet so the sidebar can show the live roster.
            // WebRTC signaling and voice E2EE keys remain restricted to people who
            // are actually in `state.voice`.
            broadcast_to_channel(
                state,
                &channel_id,
                &GatewayEvent::VoiceState {
                    channel_id: channel_id.clone(),
                    user_id: user_id.to_string(),
                    user: me.clone(),
                    joined: true,
                    muted,
                    video,
                    screen: false,
                    listen_only,
                },
            )
            .await;
        }

        ClientEvent::LeaveVoice { channel_id } => {
            leave_voice(state, user_id, me, &channel_id).await;
        }

        ClientEvent::VoiceMeta {
            channel_id,
            muted,
            video,
            screen,
            listen_only,
        } => {
            let Some(me) = me else { return };
            // Re-check access on every meta update: a user kicked/removed after joining
            // stays in the room map until WS disconnect, and would otherwise keep
            // broadcasting VoiceState. Drop the update if they can no longer see the
            // channel (the async check runs before any lock is taken).
            if !crate::api::messages::user_can_access(state, &channel_id, user_id).await {
                return;
            }
            {
                let mut rooms = state.voice.write().unwrap_or_else(|e| e.into_inner());
                if let Some(room) = rooms.get_mut(&channel_id) {
                    if let Some(m) = room.get_mut(user_id) {
                        m.muted = muted;
                        m.video = video;
                        m.screen = screen;
                        m.listen_only = listen_only;
                    }
                }
            }
            broadcast_to_channel(
                state,
                &channel_id,
                &GatewayEvent::VoiceState {
                    channel_id: channel_id.clone(),
                    user_id: user_id.to_string(),
                    user: me.clone(),
                    joined: true,
                    muted,
                    video,
                    screen,
                    listen_only,
                },
            )
            .await;
        }

        ClientEvent::Signal {
            to,
            channel_id,
            kind,
            payload,
        } => {
            // A sender kicked after joining lingers in the room map until disconnect;
            // re-check channel access so they can't keep relaying signaling.
            if !crate::api::messages::user_can_access(state, &channel_id, user_id).await {
                tracing::debug!("gateway: rejected signal from {user_id}: no channel access");
                return;
            }
            // Only relay between two users who are BOTH in this voice room.
            // Prevents an outsider from injecting signaling at an arbitrary user.
            let authorized = {
                let rooms = state.voice.read().unwrap_or_else(|e| e.into_inner());
                rooms
                    .get(&channel_id)
                    .is_some_and(|room| room.contains_key(user_id) && room.contains_key(&to))
            };
            if !authorized {
                tracing::debug!("gateway: rejected unauthorized signal from {user_id} to {to}");
                return;
            }
            // Stamp `from` server-side — clients cannot spoof the sender.
            let target = to.clone();
            broadcast_to_user(
                &state.sessions,
                &target,
                &GatewayEvent::VoiceSignal {
                    from: user_id.to_string(),
                    to,
                    channel_id,
                    kind,
                    payload,
                },
            );
        }

        ClientEvent::Typing { channel_id } => {
            if privacy_enabled(state, user_id) {
                return;
            }
            let Some(me) = me else { return };
            // Authorize before broadcasting: a user kicked/removed (or never a member)
            // must not be able to forge typing indicators in channels they can't see.
            // Mirrors the Ack/Signal/VoiceMeta handlers — the async check runs before
            // any lock is taken.
            if !crate::api::messages::user_can_access(state, &channel_id, user_id).await {
                return;
            }
            // Server-side throttle: drop pings within TYPING_COOLDOWN of the last
            // one for this (user, channel), so a misbehaving client can't flood
            // the DB + broadcast path. No await is held across the locks.
            let key = (user_id.to_string(), channel_id.clone());
            {
                let cooldowns = state
                    .typing_cooldowns
                    .read()
                    .unwrap_or_else(|e| e.into_inner());
                if cooldowns
                    .get(&key)
                    .is_some_and(|t| t.elapsed() < TYPING_COOLDOWN)
                {
                    return;
                }
            }
            {
                let mut cooldowns = state
                    .typing_cooldowns
                    .write()
                    .unwrap_or_else(|e| e.into_inner());
                // Per-user bound: a single connection can't pin entries for unbounded
                // channels. Only enforce when this key is genuinely new (re-typing an
                // already-tracked channel just refreshes the timestamp, no growth). At
                // the cap, drop this user's stalest entry before inserting.
                let this_user = &key.0;
                if !cooldowns.contains_key(&key) {
                    let user_entries = cooldowns.keys().filter(|(u, _)| u == this_user).count();
                    if user_entries >= MAX_TYPING_CHANNELS_PER_USER {
                        if let Some(oldest) = cooldowns
                            .iter()
                            .filter(|((u, _), _)| u == this_user)
                            .max_by_key(|(_, t)| t.elapsed())
                            .map(|(k, _)| k.clone())
                        {
                            cooldowns.remove(&oldest);
                        }
                    }
                }
                cooldowns.insert(key, Instant::now());
                // Global backstop — periodically evict entries past the cooldown window.
                if cooldowns.len() > 1024 {
                    cooldowns.retain(|_, t| t.elapsed() < TYPING_COOLDOWN * 4);
                }
            }

            // Fan out to everyone who can see the channel. Clients ignore their own.
            broadcast_to_channel(
                state,
                &channel_id,
                &GatewayEvent::TypingStart {
                    channel_id: channel_id.clone(),
                    user_id: user_id.to_string(),
                    user: me.clone(),
                },
            )
            .await;
        }

        ClientEvent::Ack {
            channel_id,
            message_id,
        } => {
            handle_ack(state, user_id, &channel_id, &message_id).await;
        }

        ClientEvent::SetActivity { activity } => {
            if privacy_enabled(state, user_id) && activity.is_some() {
                return;
            }
            let sanitized = activity.and_then(|a| a.sanitized());
            {
                let mut acts = state.activities.write().unwrap_or_else(|e| e.into_inner());
                match &sanitized {
                    Some(a) => {
                        acts.insert(user_id.to_string(), a.clone());
                    }
                    None => {
                        acts.remove(user_id);
                    }
                }
            }
            broadcast_presence(state, user_id, true).await;
        }

        ClientEvent::SetPresence { idle } => {
            if privacy_enabled(state, user_id) {
                return;
            }
            let changed = {
                let mut set = state.idle.write().unwrap_or_else(|e| e.into_inner());
                if idle {
                    set.insert(user_id.to_string())
                } else {
                    set.remove(user_id)
                }
            };
            if changed {
                broadcast_presence(state, user_id, true).await; // re-broadcast online/idle
            }
        }

        ClientEvent::SetPrivacyMode { enabled } => {
            let was_enabled = privacy_enabled(state, user_id);
            if enabled == was_enabled {
                return;
            }
            set_privacy_mode(state, user_id, enabled);
            if enabled {
                state
                    .activities
                    .write()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(user_id);
                state
                    .idle
                    .write()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(user_id);
                // Appear offline to peers while Privacy Mode is active.
                broadcast_presence(state, user_id, false).await;
            } else {
                // Re-appear online when the user explicitly leaves Privacy Mode.
                broadcast_presence(state, user_id, true).await;
            }
        }

        ClientEvent::WatchControl {
            channel_id,
            action,
            url,
            position,
        } => {
            handle_watch_control(state, user_id, &channel_id, &action, url, position).await;
        }

        ClientEvent::Heartbeat => {
            // A heartbeat proves the user is online: refresh the dead-man's-switch clock,
            // at most once per HEARTBEAT_TOUCH_INTERVAL on this connection.
            if last_heartbeat_touch.is_none_or(|t| t.elapsed() >= HEARTBEAT_TOUCH_INTERVAL) {
                crate::api::users::touch_active(&state.db, user_id).await;
                *last_heartbeat_touch = Some(Instant::now());
            }
        }
    }
}

/// Advance a user's read cursor in a channel, and (for DMs) broadcast the
/// resulting ReadReceipt to the channel so the sender sees "Seen".
async fn handle_ack(state: &AppState, user_id: &str, channel_id: &str, message_id: &str) {
    // Authorize: the user must be able to see this channel.
    if !crate::api::messages::user_can_access(state, channel_id, user_id).await {
        return;
    }

    // Resolve the acked message's watermark; it must belong to this channel.
    let watermark: Option<i64> =
        sqlx::query_scalar("SELECT created_at FROM messages WHERE id = ? AND channel_id = ?")
            .bind(message_id)
            .bind(channel_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten();
    let Some(watermark) = watermark else { return };

    // Only ever advance forward. Re-acking an already-read message is a no-op,
    // which also throttles a misbehaving client (no redundant broadcast).
    let prev: Option<i64> = sqlx::query_scalar(
        "SELECT last_read_at FROM channel_reads WHERE channel_id = ? AND user_id = ?",
    )
    .bind(channel_id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await
    .ok()
    .flatten();
    if prev.is_some_and(|p| p >= watermark) {
        return;
    }

    let _ = sqlx::query(
        "INSERT INTO channel_reads (channel_id, user_id, last_read_message_id, last_read_at)
         VALUES (?,?,?,?)
         ON CONFLICT(channel_id, user_id) DO UPDATE SET
            last_read_message_id = excluded.last_read_message_id,
            last_read_at = excluded.last_read_at",
    )
    .bind(channel_id)
    .bind(user_id)
    .bind(message_id)
    .bind(watermark)
    .execute(&state.db)
    .await;

    // Receipts are a DM-only affordance: a channel with NULL server_id is a DM.
    // Decode as Option<String> so NULL → None (a bare String coerces NULL to "").
    let server_id: Option<String> =
        sqlx::query_scalar::<_, Option<String>>("SELECT server_id FROM channels WHERE id = ?")
            .bind(channel_id)
            .fetch_optional(&state.db)
            .await
            .ok()
            .flatten()
            .flatten();
    if server_id.is_none() && !privacy_enabled(state, user_id) {
        broadcast_to_channel(
            state,
            channel_id,
            &GatewayEvent::ReadReceipt {
                channel_id: channel_id.to_string(),
                user_id: user_id.to_string(),
                last_read_message_id: message_id.to_string(),
                last_read_at: watermark,
            },
        )
        .await;
    }
}

/// Remove a user from one voice channel and notify everyone who can see that channel.
async fn leave_voice(state: &AppState, user_id: &str, me: Option<&PublicUser>, channel_id: &str) {
    let removed = {
        let mut rooms = state.voice.write().unwrap_or_else(|e| e.into_inner());
        if let Some(room) = rooms.get_mut(channel_id) {
            let r = room.remove(user_id).is_some();
            if room.is_empty() {
                rooms.remove(channel_id);
            }
            r
        } else {
            false
        }
    };
    if !removed {
        return;
    }
    if let Some(me) = me {
        broadcast_to_channel(
            state,
            channel_id,
            &GatewayEvent::VoiceState {
                channel_id: channel_id.to_string(),
                user_id: user_id.to_string(),
                user: me.clone(),
                joined: false,
                muted: false,
                video: false,
                screen: false,
                listen_only: false,
            },
        )
        .await;
    }
}

/// Remove a user from every voice room in one server (they were kicked, banned or left),
/// announcing each departure exactly like a normal leave.
pub async fn evict_from_server_voice(state: &AppState, server_id: &str, user_id: &str) {
    let server_channels: HashSet<String> =
        sqlx::query_scalar("SELECT id FROM channels WHERE server_id = ?")
            .bind(server_id)
            .fetch_all(&state.db)
            .await
            .unwrap_or_else(|e| {
                tracing::warn!(
                    "evict_from_server_voice channels query failed for {server_id}: {e}"
                );
                Vec::new()
            })
            .into_iter()
            .collect();
    let seats: Vec<(String, PublicUser)> = {
        let rooms = state.voice.read().unwrap_or_else(|e| e.into_inner());
        rooms
            .iter()
            .filter(|(channel_id, _)| server_channels.contains(*channel_id))
            .filter_map(|(channel_id, room)| {
                room.get(user_id)
                    .map(|m| (channel_id.clone(), m.user.clone()))
            })
            .collect()
    };
    for (channel_id, user) in seats {
        leave_voice(state, user_id, Some(&user), &channel_id).await;
    }
}

/// Remove a user from every voice channel on disconnect.
async fn cleanup_voice(state: &AppState, user_id: &str, me: Option<&PublicUser>) {
    let channels: Vec<String> = {
        let rooms = state.voice.read().unwrap_or_else(|e| e.into_inner());
        rooms
            .iter()
            .filter(|(_, room)| room.contains_key(user_id))
            .map(|(cid, _)| cid.clone())
            .collect()
    };
    for cid in channels {
        leave_voice(state, user_id, me, &cid).await;
    }
}

async fn load_public_user(state: &AppState, user_id: &str) -> Option<PublicUser> {
    sqlx::query_as::<_, crate::types::User>("SELECT * FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_one(&state.db)
        .await
        .ok()
        .map(PublicUser::from)
}

/// Announce online/offline to all servers the user belongs to.
/// online → "online" unless the client reported idle; otherwise "offline".
fn presence_status(state: &AppState, user_id: &str, online: bool) -> String {
    if !online {
        "offline".to_string()
    } else if state
        .idle
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .contains(user_id)
    {
        "idle".to_string()
    } else {
        "online".to_string()
    }
}

/// Everyone who can see this user's presence: people who share a server with them OR
/// share a DM / group DM with them (includes the user themselves, so their own
/// sessions get the echo). Distinct user_ids.
async fn presence_audience(state: &AppState, user_id: &str) -> Vec<String> {
    sqlx::query_scalar(
        "SELECT DISTINCT u FROM (
           SELECT sm2.user_id AS u FROM server_members sm1
             JOIN server_members sm2 ON sm2.server_id = sm1.server_id
             WHERE sm1.user_id = ?
           UNION
           SELECT dp2.user_id AS u FROM dm_participants dp1
             JOIN dm_participants dp2 ON dp2.channel_id = dp1.channel_id
             WHERE dp1.user_id = ?
         )",
    )
    .bind(user_id)
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_else(|e| {
        tracing::warn!("presence_audience query failed for {user_id}: {e}");
        Vec::new()
    })
}

async fn broadcast_presence(state: &AppState, user_id: &str, online: bool) {
    if online && privacy_enabled(state, user_id) {
        return;
    }
    let status = presence_status(state, user_id, online);
    let activity = if online {
        state
            .activities
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .get(user_id)
            .cloned()
    } else {
        None
    };
    let event = GatewayEvent::PresenceUpdate {
        user_id: user_id.to_string(),
        online,
        status,
        activity,
    };
    // Audience now includes DM-only contacts, not just shared-server members.
    for uid in presence_audience(state, user_id).await {
        broadcast_to_user(&state.sessions, &uid, &event);
    }
}

/// Push the just-connected user a one-shot presence snapshot: a PresenceUpdate for
/// every user currently online in a server they share (carrying that user's current
/// activity). Reuses the normal PresenceUpdate path — no new event type or client code.
async fn send_presence_snapshot(
    state: &AppState,
    user_id: &str,
    tx: &broadcast::Sender<GatewayEvent>,
) {
    // Co-members AND DM/group-DM partners, so DM-only contacts show online too.
    let audience = presence_audience(state, user_id).await;

    // Sync section — no await while the locks are held.
    let sessions = state.sessions.read().unwrap_or_else(|e| e.into_inner());
    let acts = state.activities.read().unwrap_or_else(|e| e.into_inner());
    let idle = state.idle.read().unwrap_or_else(|e| e.into_inner());
    for uid in audience {
        if uid == user_id || !sessions.contains_key(&uid) || privacy_enabled(state, &uid) {
            continue;
        }
        let status = if idle.contains(&uid) {
            "idle"
        } else {
            "online"
        };
        let _ = tx.send(GatewayEvent::PresenceUpdate {
            user_id: uid.clone(),
            online: true,
            status: status.to_string(),
            activity: acts.get(&uid).cloned(),
        });
    }
}

/// Push the just-connected user a snapshot of who's currently in voice channels they
/// can access — so "X is in voice · Join" shows immediately. Reuses VoiceState.
async fn send_voice_snapshot(
    state: &AppState,
    user_id: &str,
    tx: &broadcast::Sender<GatewayEvent>,
) {
    // Copy the rooms out of the lock, then access-check + send (no await under the lock).
    let rooms: Vec<(String, Vec<VoiceMember>)> = {
        let r = state.voice.read().unwrap_or_else(|e| e.into_inner());
        r.iter()
            .map(|(cid, m)| (cid.clone(), m.values().cloned().collect()))
            .collect()
    };
    for (channel_id, members) in rooms {
        if members.is_empty()
            || !crate::api::messages::user_can_access(state, &channel_id, user_id).await
        {
            continue;
        }
        for m in members {
            let _ = tx.send(GatewayEvent::VoiceState {
                channel_id: channel_id.clone(),
                user_id: m.user.id.clone(),
                user: m.user.clone(),
                joined: true,
                muted: m.muted,
                video: m.video,
                screen: m.screen,
                listen_only: m.listen_only,
            });
        }
    }
}

/// Apply a watch-party control to a channel's session and broadcast the new state.
/// The server is a relay — clients send the authoritative `position`; we just store
/// it with a timestamp so late/other clients can compute the live position.
async fn handle_watch_control(
    state: &AppState,
    user_id: &str,
    channel_id: &str,
    action: &str,
    url: Option<String>,
    position: Option<f64>,
) {
    if !crate::api::messages::user_can_access(state, channel_id, user_id).await {
        return;
    }
    // For "set", validate the user-supplied URL up front (before acquiring the lock,
    // since the SSRF guard is async). Reject schemes other than http(s) and any host
    // that resolves to a private/loopback/link-local address — the same guard used by
    // the link-preview fetcher — so a watch-party URL can't be an SSRF vector.
    let validated_url: Option<String> = if action == "set" {
        match url
            .as_deref()
            .filter(|u| u.starts_with("http://") || u.starts_with("https://"))
        {
            Some(u) if crate::api::og::is_public_url(u).await => Some(u.to_string()),
            _ => return,
        }
    } else {
        None
    };
    let now = crate::types::now_unix();
    // Compute the new session under the lock; broadcast after it's dropped (no await held).
    let session = {
        let mut watch = state.watch.write().unwrap_or_else(|e| e.into_inner());
        match action {
            "set" => {
                let Some(url) = validated_url else {
                    return;
                };
                let s = crate::types::WatchSession {
                    url,
                    paused: true,
                    position: 0.0,
                    updated_at: now,
                    host_id: user_id.to_string(),
                };
                watch.insert(channel_id.to_string(), s.clone());
                Some(s)
            }
            "play" | "pause" | "seek" => {
                let Some(s) = watch.get_mut(channel_id) else {
                    return;
                };
                // Only the host who started the session may drive playback; any other
                // channel member is access-authorized but must not hijack it.
                if s.host_id != user_id {
                    return;
                }
                if action == "play" {
                    s.paused = false;
                } else if action == "pause" {
                    s.paused = true;
                }
                if let Some(p) = position {
                    s.position = p.max(0.0);
                }
                s.updated_at = now;
                Some(s.clone())
            }
            "stop" => {
                // Only the host may end the session (silently ignore non-hosts).
                match watch.get(channel_id) {
                    Some(s) if s.host_id == user_id => {
                        watch.remove(channel_id);
                        None
                    }
                    _ => return,
                }
            }
            _ => return,
        }
    };
    broadcast_to_channel(
        state,
        channel_id,
        &GatewayEvent::WatchUpdate {
            channel_id: channel_id.to_string(),
            session,
        },
    )
    .await;
}

async fn build_ready(user_id: &str, state: &AppState) -> anyhow::Result<GatewayEvent> {
    use crate::types::{PublicUser, ServerWithChannels};

    let user = sqlx::query_as::<_, crate::types::User>("SELECT * FROM users WHERE id = ?")
        .bind(user_id)
        .fetch_one(&state.db)
        .await?;

    let servers = sqlx::query_as::<_, crate::types::Server>(
        "SELECT s.* FROM servers s
         JOIN server_members sm ON sm.server_id = s.id
         WHERE sm.user_id = ?",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await?;

    // Build each server through the same View Channel filter REST uses, so a channel
    // this user can't see never reaches them. All servers run concurrently (WAL +
    // 16-conn pool) to keep the connect critical path short.
    let server_list: Vec<ServerWithChannels> = futures_util::future::join_all(
        servers
            .iter()
            .map(|server| crate::api::servers::fetch_full_for_user(&server.id, state, user_id)),
    )
    .await
    .into_iter()
    .filter_map(|full| {
        full.map_err(|(_, e)| tracing::warn!("gateway: Ready skipped a server for {user_id}: {e}"))
            .ok()
    })
    .collect();

    let dms = sqlx::query_as::<_, crate::types::Channel>(
        "SELECT c.* FROM channels c
         JOIN dm_participants dp ON dp.channel_id = c.id
         WHERE dp.user_id = ?",
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();

    // Per-channel unread counts (one query): messages newer than the user's read cursor,
    // excluding their own and expired ones, across every channel they can see. Seeds the
    // client's unread badges on connect so they no longer wipe to zero on reload.
    let now = crate::types::now_unix();
    let unread_rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT m.channel_id, COUNT(*) AS cnt
         FROM messages m
         LEFT JOIN channel_reads cr ON cr.channel_id = m.channel_id AND cr.user_id = ?
         WHERE m.author_id != ?
           AND m.created_at > COALESCE(cr.last_read_at, 0)
           AND (m.expires_at IS NULL OR m.expires_at > ?)
           AND m.channel_id IN (
             SELECT c.id FROM channels c
               JOIN server_members sm ON sm.server_id = c.server_id WHERE sm.user_id = ?
             UNION
             SELECT channel_id FROM dm_participants WHERE user_id = ?
           )
         GROUP BY m.channel_id",
    )
    .bind(user_id)
    .bind(user_id)
    .bind(now)
    .bind(user_id)
    .bind(user_id)
    .fetch_all(&state.db)
    .await
    .unwrap_or_default();
    // Only channels listed above (i.e. ones this user can view) may carry an unread count.
    let visible: HashSet<&str> = server_list
        .iter()
        .flat_map(|s| s.channels.iter())
        .chain(dms.iter())
        .map(|c| c.id.as_str())
        .collect();
    let unread: std::collections::HashMap<String, i64> = unread_rows
        .into_iter()
        .filter(|(channel_id, _)| visible.contains(channel_id.as_str()))
        .collect();

    Ok(GatewayEvent::Ready {
        user: PublicUser::from(user),
        servers: server_list,
        dms,
        unread,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// State over a fresh migrated database holding user `u1` at `token_version`.
    async fn state_with_user(token_version: i64) -> AppState {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        sqlx::query(
            "INSERT INTO users (id, username, display_name, password_hash, created_at, token_version)
             VALUES ('u1', 'u1', 'U1', 'h', 0, ?)",
        )
        .bind(token_version)
        .execute(&pool)
        .await
        .unwrap();
        crate::build_state(pool)
    }

    /// The ticket was redeemed at version 0, then "log out everywhere" moved the account
    /// to 1 while the map held nothing of this connection's to close.
    #[tokio::test]
    async fn a_connection_that_joins_after_logout_everywhere_is_dropped() {
        let state = state_with_user(1).await;
        let (tx, _rx) = broadcast::channel(1);
        let outcome = register_connection(&state, "u1", 1, tx, 0).await;
        assert!(!matches!(outcome, Registration::Registered));
        assert!(
            !state
                .sessions
                .read()
                .unwrap()
                .get("u1")
                .is_some_and(|conns| conns.contains_key(&1)),
            "the connection is not left in the session map"
        );
    }

    #[tokio::test]
    async fn a_connection_whose_version_is_current_stays_registered() {
        let state = state_with_user(1).await;
        let (tx, _rx) = broadcast::channel(1);
        let outcome = register_connection(&state, "u1", 1, tx, 1).await;
        assert!(matches!(outcome, Registration::Registered));
        assert!(state
            .sessions
            .read()
            .unwrap()
            .get("u1")
            .is_some_and(|conns| conns.contains_key(&1)));
    }

    /// Browsers wake timers in a long-hidden tab about once a minute, so a backgrounded
    /// client's 20 s heartbeat can arrive a minute late, or two minutes when a wake-up
    /// slips. Closing before then would drop backgrounded web clients.
    #[test]
    fn idle_limit_outlasts_heartbeats_from_a_throttled_background_tab() {
        let throttled_wakeup = Duration::from_secs(60);
        assert!(
            IDLE_TIMEOUT > 2 * throttled_wakeup,
            "idle limit {IDLE_TIMEOUT:?}"
        );
    }
}
