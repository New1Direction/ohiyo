use std::{
    collections::HashMap,
    sync::{Arc, Mutex, RwLock},
    time::{Duration, Instant},
};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
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
pub type WsTickets = Arc<Mutex<HashMap<String, (String, Instant)>>>;
const TICKET_TTL: Duration = Duration::from_secs(30);

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
    auth: auth::AuthUser,
    State(state): State<AppState>,
) -> Json<WsTicketResponse> {
    let ticket: String = rand::thread_rng()
        .sample_iter(&rand::distributions::Alphanumeric)
        .take(32)
        .map(char::from)
        .collect();
    let mut tickets = state.tickets.lock().unwrap_or_else(|e| e.into_inner());
    tickets.retain(|_, (_, issued)| issued.elapsed() < TICKET_TTL); // prune expired
    tickets.insert(ticket.clone(), (auth.0, Instant::now()));
    Json(WsTicketResponse { ticket })
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
    Arc::new(RwLock::new(std::collections::HashSet::new()))
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
        Some(sid) => sqlx::query_scalar("SELECT user_id FROM server_members WHERE server_id = ?")
            .bind(sid)
            .fetch_all(&state.db)
            .await
            .unwrap_or_else(|e| {
                tracing::warn!(
                    "broadcast_to_channel server members query failed for {channel_id}: {e}"
                );
                Vec::new()
            }),
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

/// Broadcast to everyone currently in a voice channel, optionally skipping one user.
fn broadcast_to_voice(
    sessions: &SessionMap,
    voice: &VoiceRooms,
    channel_id: &str,
    event: &GatewayEvent,
    except: Option<&str>,
) {
    let rooms = voice.read().unwrap_or_else(|e| e.into_inner());
    let Some(room) = rooms.get(channel_id) else {
        return;
    };
    let map = sessions.read().unwrap_or_else(|e| e.into_inner());
    for uid in room.keys() {
        if Some(uid.as_str()) == except {
            continue;
        }
        if let Some(conns) = map.get(uid) {
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
    let user_id = {
        let mut tickets = state.tickets.lock().unwrap_or_else(|e| e.into_inner());
        match tickets.remove(&q.ticket) {
            Some((uid, issued)) if issued.elapsed() < TICKET_TTL => uid,
            _ => return (StatusCode::UNAUTHORIZED, "Invalid or expired ticket").into_response(),
        }
    };
    ws.on_upgrade(move |socket| handle_socket(socket, user_id, state))
}

async fn handle_socket(socket: WebSocket, user_id: String, state: AppState) {
    // Generous capacity — WebRTC ICE trickle is chatty (dozens of candidates/sec).
    let (tx, mut rx) = broadcast::channel::<GatewayEvent>(1024);

    // Register this connection (multi-device: a user can have many at once).
    let conn_id = next_conn_id();
    {
        let mut map = state.sessions.write().unwrap_or_else(|e| e.into_inner());
        map.entry(user_id.clone())
            .or_default()
            .insert(conn_id, tx.clone());
    }

    // Connecting counts as activity → refresh the dead-man's-switch liveness clock.
    crate::api::users::touch_active(&state.db, &user_id).await;

    // Load our own public profile once for voice events.
    let me = load_public_user(&state, &user_id).await;

    // Announce presence to the people who can see us.
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
    let send_task = tokio::spawn(async move {
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
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    });

    // Snapshot: tell the just-connected user who's currently online in their servers
    // (and their activity) so presence shows immediately, not just on the next change.
    send_presence_snapshot(&state, &user_id, &tx).await;
    send_voice_snapshot(&state, &user_id, &tx).await;

    // Drain incoming messages: WebRTC signaling, voice state, heartbeats.
    while let Some(Ok(msg)) = ws_rx.next().await {
        match msg {
            Message::Close(_) => break,
            Message::Text(t) => match serde_json::from_str::<ClientEvent>(&t) {
                Ok(ev) => handle_client_event(ev, &user_id, me.as_ref(), &state).await,
                Err(e) => tracing::debug!("gateway: bad client frame from {user_id}: {e}"),
            },
            _ => {}
        }
    }

    send_task.abort();

    // Leave any voice channels we were in, notifying peers.
    cleanup_voice(&state, &user_id, me.as_ref());

    // Unregister THIS connection. Only when the user's last connection drops do we
    // clear activity + announce offline (otherwise closing one device flaps presence).
    let last_connection = {
        let mut map = state.sessions.write().unwrap_or_else(|e| e.into_inner());
        if let Some(conns) = map.get_mut(&user_id) {
            conns.remove(&conn_id);
            if conns.is_empty() {
                map.remove(&user_id);
                true
            } else {
                false
            }
        } else {
            true
        }
    };
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

/// Handle one client→server event.
async fn handle_client_event(
    ev: ClientEvent,
    user_id: &str,
    me: Option<&PublicUser>,
    state: &AppState,
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

            // Tell everyone else that we joined.
            broadcast_to_voice(
                &state.sessions,
                &state.voice,
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
                Some(user_id),
            );
        }

        ClientEvent::LeaveVoice { channel_id } => {
            leave_voice(state, user_id, me, &channel_id);
        }

        ClientEvent::VoiceMeta {
            channel_id,
            muted,
            video,
            screen,
            listen_only,
        } => {
            let Some(me) = me else { return };
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
            broadcast_to_voice(
                &state.sessions,
                &state.voice,
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
                None,
            );
        }

        ClientEvent::Signal {
            to,
            channel_id,
            kind,
            payload,
        } => {
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
            let Some(me) = me else { return };
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
                cooldowns.insert(key, Instant::now());
                // Bound memory — periodically evict entries past the cooldown window.
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

        ClientEvent::WatchControl {
            channel_id,
            action,
            url,
            position,
        } => {
            handle_watch_control(state, user_id, &channel_id, &action, url, position).await;
        }

        ClientEvent::Heartbeat => {}
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
    if server_id.is_none() {
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

/// Remove a user from one voice channel and notify the remaining peers.
fn leave_voice(state: &AppState, user_id: &str, me: Option<&PublicUser>, channel_id: &str) {
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
        broadcast_to_voice(
            &state.sessions,
            &state.voice,
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
            // Don't echo the leave back to the departing user themselves.
            Some(user_id),
        );
    }
}

/// Remove a user from every voice channel on disconnect.
fn cleanup_voice(state: &AppState, user_id: &str, me: Option<&PublicUser>) {
    let channels: Vec<String> = {
        let rooms = state.voice.read().unwrap_or_else(|e| e.into_inner());
        rooms
            .iter()
            .filter(|(_, room)| room.contains_key(user_id))
            .map(|(cid, _)| cid.clone())
            .collect()
    };
    for cid in channels {
        leave_voice(state, user_id, me, &cid);
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
        if uid == user_id || !sessions.contains_key(&uid) {
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
                watch.remove(channel_id);
                None
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

    // Per-server channels/members/categories: run the three queries concurrently per
    // server, and all servers concurrently (WAL + 16-conn pool) — instead of 3N serial
    // queries on the connect critical path.
    let server_list: Vec<ServerWithChannels> =
        futures_util::future::join_all(servers.into_iter().map(|server| {
            let db = &state.db;
            async move {
                let (channels, members, categories) = tokio::join!(
                    sqlx::query_as::<_, crate::types::Channel>(
                        "SELECT * FROM channels WHERE server_id = ? ORDER BY position",
                    )
                    .bind(&server.id)
                    .fetch_all(db),
                    sqlx::query_as::<_, crate::types::User>(
                        "SELECT u.* FROM users u
                         JOIN server_members sm ON sm.user_id = u.id
                         WHERE sm.server_id = ?",
                    )
                    .bind(&server.id)
                    .fetch_all(db),
                    sqlx::query_as::<_, crate::types::Category>(
                        "SELECT * FROM categories WHERE server_id = ? ORDER BY position",
                    )
                    .bind(&server.id)
                    .fetch_all(db),
                );
                ServerWithChannels {
                    server,
                    channels: channels.unwrap_or_default(),
                    members: members
                        .unwrap_or_default()
                        .into_iter()
                        .map(PublicUser::from)
                        .collect(),
                    categories: categories.unwrap_or_default(),
                }
            }
        }))
        .await;

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
    let unread: std::collections::HashMap<String, i64> = unread_rows.into_iter().collect();

    Ok(GatewayEvent::Ready {
        user: PublicUser::from(user),
        servers: server_list,
        dms,
        unread,
    })
}
