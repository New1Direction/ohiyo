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
    /// The account a webhook posts as (api::webhooks), not a person: it can't sign in and
    /// isn't found, messaged or befriended.
    #[sqlx(default)]
    #[serde(default)]
    pub is_bot: bool,
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
    /// True when this channel was imported from Discord and is stored as plaintext
    /// archive content rather than an Ohiyo-native E2E space.
    #[serde(default)]
    pub imported: bool,
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
    /// A thread's channel: the space text channel it hangs off. None for every other
    /// channel. A thread takes this channel's permissions and is deleted with it.
    #[serde(default)]
    #[sqlx(default)]
    pub parent_id: Option<String>,
    /// The message a thread started from (it may since have been deleted). None for
    /// anything that isn't a thread.
    #[serde(default)]
    #[sqlx(default)]
    pub thread_message_id: Option<String>,
}

/// A thread as the app lists it: its channel, how many messages it holds, when the last
/// one came, and whether the message it started from has been deleted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ThreadSummary {
    #[serde(flatten)]
    pub channel: Channel,
    pub message_count: i64,
    pub last_message_at: Option<i64>,
    pub starter_deleted: bool,
    /// Who started it (they may rename or delete it); None for a thread started before that
    /// was recorded, or once they've deleted their account.
    #[serde(default)]
    pub owner_id: Option<String>,
    /// Nobody has written in it for a week (worked out when it was read).
    #[serde(default)]
    pub archived: bool,
    /// Whether the person asking follows it: only in their own copy (their list, Ready, a
    /// follow change), never in what everyone watching the channel hears.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub following: Option<bool>,
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
    #[serde(default)]
    pub is_everyone: bool,
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
    /// The reply quotes a webhook (another service), shown with an APP badge.
    #[serde(default, skip_serializing_if = "is_false")]
    pub bot: bool,
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
    /// A webhook, not a person: the app shows an APP badge and no profile. Left out for people.
    #[serde(default, skip_serializing_if = "is_false")]
    pub bot: bool,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl From<User> for PublicUser {
    fn from(u: User) -> Self {
        Self {
            id: u.id,
            username: u.username,
            display_name: u.display_name,
            avatar_url: u.avatar_url,
            bot: u.is_bot,
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
    /// When `position` was true, in seconds on the server's clock (with fractions: a
    /// whole-second stamp would put guests up to a second off).
    pub updated_at: f64,
    pub host_id: String,
    /// The server's clock when this copy was sent. Clients compare it with their own
    /// clock, so a device whose clock is wrong still lands on the right position.
    #[serde(default)]
    pub server_time: f64,
}

/// How one space or channel (a space channel, DM or group chat) notifies its member. Only
/// what differs from the defaults is stored: every message notifies, nothing is muted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, sqlx::FromRow)]
pub struct NotificationSetting {
    /// "server" or "channel".
    pub target_type: String,
    pub target_id: String,
    /// A space's level: "all", "mentions" or "nothing". None is the default (all).
    pub level: Option<String>,
    pub muted: bool,
    /// When a mute ends (unix seconds). None while muted: until it's turned back on.
    pub muted_until: Option<i64>,
}

impl NotificationSetting {
    /// Muted at `now`: a mute whose time has passed is over.
    pub fn is_muted(&self, now: i64) -> bool {
        self.muted && self.muted_until.is_none_or(|until| until > now)
    }

    /// The setting as it stands at `now`, with an ended mute cleared.
    pub fn as_of(mut self, now: i64) -> Self {
        if self.muted && !self.is_muted(now) {
            self.muted = false;
            self.muted_until = None;
        }
        self
    }

    /// Nothing differs from the defaults, so there's nothing to keep.
    pub fn is_default(&self) -> bool {
        !self.muted && matches!(self.level.as_deref(), None | Some("all"))
    }
}

// ── WebSocket gateway events ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", content = "d")]
pub enum GatewayEvent {
    Ready {
        user: PublicUser,
        servers: Vec<ServerWithChannels>,
        dms: Vec<Channel>,
        /// channel_id → the other person in each 1:1 DM. The channel itself is named
        /// "dm", so without this a client can't say who a chat is with.
        #[serde(default)]
        dm_peers: std::collections::HashMap<String, PublicUser>,
        /// channel_id → unread message count (newer than the user's read cursor). Lets
        /// the client seed unread badges on connect instead of starting from zero.
        #[serde(default)]
        unread: std::collections::HashMap<String, i64>,
        /// The account's notification settings for the spaces and chats listed above.
        #[serde(default)]
        notification_settings: Vec<NotificationSetting>,
        /// The threads the account follows (in channels it can see); their unread counts
        /// are in `unread`.
        #[serde(default)]
        followed_threads: Vec<ThreadSummary>,
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
    /// A relayed voice/video E2EE room-key envelope (pairwise-encrypted). Call
    /// participants gossip these to converge on one shared FrameCryptor key; the SFU
    /// and server only ever see opaque ciphertext.
    VoiceKeyDistribution {
        channel_id: String,
        from_user_id: String,
        envelope: String,
    },
    ServerCreate(ServerWithChannels),
    ServerDelete {
        id: String,
    },
    ChannelCreate(Channel),
    /// A thread started, or its message count changed (a reply, a deletion), or the message
    /// it started from was deleted. Sent to everyone who can see the thread's channel.
    ThreadUpdate(ThreadSummary),
    /// A thread was deleted (with its messages); the line under its message goes.
    ThreadDelete {
        id: String,
        parent_id: String,
        thread_message_id: Option<String>,
    },
    /// You followed or unfollowed a thread (sent to your own devices only).
    ThreadFollowUpdate {
        thread: ThreadSummary,
        following: bool,
    },
    MemberJoin {
        server_id: String,
        user: PublicUser,
    },
    /// A member left or was removed from a server.
    MemberLeave {
        server_id: String,
        user_id: String,
    },
    /// An account was deleted. Sent to everyone who shared a space, a group or a 1:1 chat
    /// with it, so their apps take its messages off the screen and close the chat.
    UserDeleted {
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
        /// True when the participant joined with no microphone (receive-only).
        #[serde(rename = "listenOnly", default)]
        listen_only: bool,
        /// True when the participant hears nobody (deafened). A deafened person is always muted.
        #[serde(default)]
        deafened: bool,
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
    /// Reply to a client `Heartbeat`, sent on that connection only, so a quiet but
    /// healthy socket still receives a frame and the client does not treat it as dead.
    HeartbeatAck,
    /// A device registered its encryption keys on this account for the first time. Sent
    /// to all of the account's sessions, so its other devices can say so at once: a
    /// stolen session could otherwise add a device and read later messages unnoticed.
    DeviceAdded {
        device_id: i64,
    },
    /// One of the account's notification settings changed. Sent to all of its sessions, so
    /// every device mutes (or stops muting) together.
    NotificationSettingsUpdate(NotificationSetting),
    /// Two-factor sign-in was turned on or off. Sent to all of the account's sessions, so
    /// its other devices know (a change they didn't make is worth a word).
    TwoFactorUpdate {
        enabled: bool,
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
    /// True when the peer joined with no microphone (receive-only).
    #[serde(rename = "listenOnly", default)]
    pub listen_only: bool,
    /// True when the peer hears nobody (deafened). A deafened peer is always muted.
    #[serde(default)]
    pub deafened: bool,
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
        /// True when the client has no microphone and joins receive-only.
        #[serde(default)]
        listen_only: bool,
        /// True when the client joins deafened. Apps that don't know about deafen leave it out.
        #[serde(default)]
        deafened: bool,
    },
    /// Leave a voice channel.
    LeaveVoice { channel_id: String },
    /// Update mute/video/screen flags while in a call.
    VoiceMeta {
        channel_id: String,
        muted: bool,
        video: bool,
        screen: bool,
        /// True when the client is participating receive-only (no microphone).
        #[serde(default)]
        listen_only: bool,
        /// True when the client hears nobody (deafened). Apps that don't know about deafen
        /// leave it out.
        #[serde(default)]
        deafened: bool,
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
    /// Toggle metadata privacy for this account's live gateway sessions. When enabled,
    /// the server suppresses peer-visible presence/activity, typing, and Seen receipts.
    SetPrivacyMode {
        #[serde(default)]
        enabled: bool,
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
    /// Token generation counter, copied from `users.token_version` at mint time.
    /// Bumping the user's version is how "log out everywhere" / revocation works.
    /// `default` keeps tokens minted before this field existed (version 0) valid.
    #[serde(default)]
    pub token_version: i64,
}

// ── Helper ────────────────────────────────────────────────────────────────────

pub fn new_id() -> String {
    Uuid::new_v4().to_string()
}

pub fn now_unix() -> i64 {
    Utc::now().timestamp()
}

/// Unix time in seconds with millisecond fractions.
pub fn now_unix_f64() -> f64 {
    Utc::now().timestamp_millis() as f64 / 1000.0
}

/// A provisioned Instant-Server instance. Mirrors the `hosted_instances` table —
/// infra metadata only (never message content or E2E keys).
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct HostedInstance {
    pub id: String,
    pub owner_id: String,
    pub name: String,
    pub subdomain: String,
    pub region: String,
    pub tier: String,
    pub status: String,
    // Internal Fly infra IDs — populated from the DB (sqlx::FromRow) but never serialized
    // to clients: machine_id feeds the `fly-replay` routing header, so disclosing it is an
    // infrastructure-targeting risk. `default` keeps any JSON round-trip valid.
    #[serde(skip_serializing, default)]
    pub machine_id: Option<String>,
    #[serde(skip_serializing, default)]
    pub volume_id: Option<String>,
    pub public_url: Option<String>,
    pub error: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}
