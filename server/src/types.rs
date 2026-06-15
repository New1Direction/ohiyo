use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ── Stored models ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct User {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub password_hash: String,
    pub avatar_url: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Server {
    pub id: String,
    pub name: String,
    pub owner_id: String,
    pub icon_url: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Channel {
    pub id: String,
    pub server_id: Option<String>,
    pub name: String,
    pub channel_type: String,
    pub position: i64,
    pub topic: Option<String>,
    pub created_at: i64,
    pub category_id: Option<String>,
    /// Disappearing-message TTL in seconds; None = off.
    #[serde(default)]
    pub disappearing_seconds: Option<i64>,
    /// Group-DM membership generation; bumped on every add/remove so clients rotate
    /// their sender keys. 0 for non-group channels.
    #[serde(default)]
    pub epoch: i64,
    /// Group-DM owner (creator); only they may remove other members. None otherwise.
    #[serde(default)]
    pub owner_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Category {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub position: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Role {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub color: Option<String>,
    pub permissions: i64,
    pub position: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Invite {
    pub code: String,
    pub server_id: String,
    pub channel_id: Option<String>,
    pub created_by: String,
    pub created_at: i64,
    pub expires_at: Option<i64>,
    pub max_uses: Option<i64>,
    pub uses: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct Message {
    pub id: String,
    pub channel_id: String,
    pub author_id: String,
    pub content: String,
    pub created_at: i64,
    pub edited_at: Option<i64>,
    pub attachments: Option<String>,
    pub reply_to: Option<String>,
    #[serde(default)]
    pub pinned: i64,
    /// JSON array string of resolved link-preview embeds (NULL until built async).
    #[serde(default)]
    pub embeds: Option<String>,
    /// Unix time this message self-destructs (disappearing messages); NULL = never.
    #[serde(default)]
    pub expires_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReactionGroup {
    pub emoji: String,
    pub count: i64,
    pub me: bool,
}

/// A compact preview of the message being replied to, resolved server-side so
/// the client can render the quote even when the original isn't loaded.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReplyPreview {
    pub id: String,
    pub author: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PollOption {
    pub id: String,
    pub text: String,
    pub votes: i64,
    pub me: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Poll {
    pub question: String,
    pub multi: bool,
    pub closes_at: Option<i64>,
    pub total_votes: i64,
    pub options: Vec<PollOption>,
}

// ── API response shapes (no password_hash) ────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicUser {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub avatar_url: Option<String>,
}

impl From<User> for PublicUser {
    fn from(u: User) -> Self {
        Self {
            id: u.id,
            username: u.username,
            display_name: u.display_name,
            avatar_url: u.avatar_url,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MessageWithAuthor {
    pub id: String,
    pub channel_id: String,
    pub author: PublicUser,
    pub content: String,
    pub created_at: i64,
    pub edited_at: Option<i64>,
    /// Parsed attachment array (not the raw DB JSON string) so clients get an array.
    pub attachments: Option<serde_json::Value>,
    pub reactions: Vec<ReactionGroup>,
    pub reply_to: Option<ReplyPreview>,
    pub pinned: bool,
    pub poll: Option<Poll>,
    /// Parsed link-preview embed array (not the raw DB JSON string), like attachments.
    pub embeds: Option<serde_json::Value>,
    /// Unix time this message self-destructs (disappearing messages); None = never.
    #[serde(default)]
    pub expires_at: Option<i64>,
}

/// What a user is currently doing — the "rich presence" layer that powers the
/// gaming / watching / working hub. Ephemeral (in-memory, cleared on disconnect).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Activity {
    /// "playing" | "watching" | "working" | "listening"
    pub kind: String,
    pub name: String,
    pub details: Option<String>,
}

impl Activity {
    /// Clamp to safe bounds and a known `kind`; returns None if unusable.
    pub fn sanitized(self) -> Option<Activity> {
        const KINDS: [&str; 4] = ["playing", "watching", "working", "listening"];
        let kind = self.kind.to_ascii_lowercase();
        if !KINDS.contains(&kind.as_str()) {
            return None;
        }
        let name: String = self.name.trim().chars().take(128).collect();
        if name.is_empty() {
            return None;
        }
        let details = self
            .details
            .map(|d| d.trim().chars().take(128).collect::<String>())
            .filter(|d| !d.is_empty());
        Some(Activity {
            kind,
            name,
            details,
        })
    }
}

/// A synced "watch party" — a shared video and playback state for a channel.
/// Ephemeral (in-memory). Clients are authoritative on `position`; the server is a
/// state relay. Effective position while playing = position + (now - updated_at).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchSession {
    pub url: String,
    pub paused: bool,
    pub position: f64,
    pub updated_at: i64,
    pub host_id: String,
}

// ── WebSocket gateway events ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", content = "d")]
pub enum GatewayEvent {
    Ready {
        user: PublicUser,
        servers: Vec<ServerWithChannels>,
        dms: Vec<Channel>,
        /// channel_id → unread message count (newer than the user's read cursor). Lets
        /// the client seed unread badges on connect instead of starting from zero.
        #[serde(default)]
        unread: std::collections::HashMap<String, i64>,
    },
    MessageCreate(MessageWithAuthor),
    /// A message's content/pinned state changed (edit or pin/unpin).
    MessageUpdate(MessageWithAuthor),
    MessageDelete {
        id: String,
        channel_id: String,
    },
    /// A channel's disappearing-message TTL changed (seconds = None turns it off).
    DisappearingUpdate {
        channel_id: String,
        seconds: Option<i64>,
    },
    /// A group member's encrypted Sender Key Distribution Message (group E2E bootstrap).
    /// `envelope` is a pairwise-encrypted SKDM only this recipient device can open.
    SenderKeyDistribution {
        channel_id: String,
        from_user_id: String,
        envelope: String,
    },
    /// A group DM's membership changed (add/remove/leave). `epoch` is the new rekey
    /// generation — clients rotate their sender key when it advances past their own.
    /// `participants` is the full current member list; a client that finds itself
    /// absent from it has been removed and drops the channel.
    GroupMembersUpdate {
        channel_id: String,
        epoch: i64,
        participants: Vec<PublicUser>,
    },
    ServerCreate(ServerWithChannels),
    ServerDelete {
        id: String,
    },
    ChannelCreate(Channel),
    MemberJoin {
        server_id: String,
        user: PublicUser,
    },
    /// A member left or was removed from a server.
    MemberLeave {
        server_id: String,
        user_id: String,
    },
    /// The recipient's effective permissions in a server changed (role add/remove/delete).
    PermissionsUpdate {
        server_id: String,
    },
    /// A server's scheduled events changed (create/rsvp/delete) — clients refetch.
    EventsChanged {
        server_id: String,
    },
    ReactionUpdate {
        message_id: String,
        channel_id: String,
        emoji: String,
        user_id: String,
        added: bool,
    },
    /// A user's read cursor advanced in a DM (drives Delivered/Seen receipts).
    /// Only fanned out for DM channels — never for server channels, to avoid
    /// broadcast storms in large servers.
    ReadReceipt {
        channel_id: String,
        user_id: String,
        last_read_message_id: String,
        last_read_at: i64,
    },
    /// Presence/online status for a user (server-scoped), with optional rich activity.
    PresenceUpdate {
        user_id: String,
        online: bool,
        /// "online" | "idle" | "offline" — richer than the bool, kept alongside it.
        #[serde(default)]
        status: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        activity: Option<Activity>,
    },
    /// Someone started typing in a channel. Clients show it for a few seconds.
    TypingStart {
        channel_id: String,
        user_id: String,
        user: PublicUser,
    },
    /// A user joined/left a voice channel, or changed mute/video/screen state.
    VoiceState {
        channel_id: String,
        user_id: String,
        user: PublicUser,
        joined: bool,
        muted: bool,
        video: bool,
        screen: bool,
    },
    /// Sent to a user when they join a voice channel: the peers already present.
    /// The joiner initiates WebRTC offers to each of these peers.
    VoiceRoster {
        channel_id: String,
        peers: Vec<VoicePeer>,
    },
    /// Relayed WebRTC signaling (SDP offer/answer or ICE candidate).
    /// The server stamps `from` to the authenticated user — clients cannot spoof it.
    VoiceSignal {
        from: String,
        to: String,
        channel_id: String,
        kind: String,    // "offer" | "answer" | "candidate"
        payload: String, // opaque SDP / ICE JSON — the server never parses it
    },
    /// A channel's watch-party state changed (None = the session ended).
    WatchUpdate {
        channel_id: String,
        session: Option<WatchSession>,
    },
}

/// A participant already present in a voice channel.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VoicePeer {
    pub user_id: String,
    pub user: PublicUser,
    pub muted: bool,
    pub video: bool,
    pub screen: bool,
}

// ── Client → server events (parsed in the gateway inbound loop) ────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", content = "d")]
pub enum ClientEvent {
    /// Join a voice/video channel. Server replies with a VoiceRoster and notifies peers.
    JoinVoice {
        channel_id: String,
        #[serde(default)]
        muted: bool,
        #[serde(default)]
        video: bool,
    },
    /// Leave a voice channel.
    LeaveVoice { channel_id: String },
    /// Update mute/video/screen flags while in a call.
    VoiceMeta {
        channel_id: String,
        muted: bool,
        video: bool,
        screen: bool,
    },
    /// Relay a WebRTC offer/answer/ICE candidate to another peer.
    Signal {
        to: String,
        channel_id: String,
        kind: String,
        payload: String,
    },
    /// The user is typing in a channel. Broadcast to that channel's audience.
    Typing { channel_id: String },
    /// Mark messages up to (and including) `message_id` as read in a channel.
    /// Advances the read cursor; for DMs it also fans out a ReadReceipt.
    Ack {
        channel_id: String,
        message_id: String,
    },
    /// Set or clear the user's current activity (rich presence). None clears it.
    SetActivity {
        #[serde(default)]
        activity: Option<Activity>,
    },
    /// Client reports it has gone idle (no input for a while) or active again.
    SetPresence {
        #[serde(default)]
        idle: bool,
    },
    /// Watch-party controls: set a video, play/pause/seek, or stop.
    WatchControl {
        channel_id: String,
        action: String, // "set" | "play" | "pause" | "seek" | "stop"
        #[serde(default)]
        url: Option<String>,
        #[serde(default)]
        position: Option<f64>,
    },
    /// Keep-alive.
    Heartbeat,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerWithChannels {
    #[serde(flatten)]
    pub server: Server,
    pub channels: Vec<Channel>,
    pub members: Vec<PublicUser>,
    #[serde(default)]
    pub categories: Vec<Category>,
}

// ── JWT claims ────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String, // user id
    pub exp: usize,
}

// ── Helper ────────────────────────────────────────────────────────────────────

pub fn new_id() -> String {
    Uuid::new_v4().to_string()
}

pub fn now_unix() -> i64 {
    Utc::now().timestamp()
}
