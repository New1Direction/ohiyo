pub mod auth;
pub mod channels;
pub mod embeds;
pub mod emoji;
pub mod events;
pub mod files;
pub mod ice;
pub mod invites;
pub mod keys;
pub mod livekit;
pub mod messages;
pub mod og;
pub mod polls;
pub mod profile;
pub mod reactions;
pub mod roles;
pub mod saved;
pub mod search;
pub mod servers;
pub mod signal;
pub mod users;
pub mod watch;

use crate::AppState;
use axum::{
    extract::DefaultBodyLimit,
    routing::{delete, get, patch, post, put},
    Router,
};
use emoji::{create_emoji, delete_emoji, list_emojis};

pub fn router() -> Router<AppState> {
    Router::new()
        // Auth
        .route("/auth/register", post(auth::register))
        .route("/auth/login", post(auth::login))
        // Users
        .route("/users/@me", get(users::me))
        .route("/users/@me/saved", get(saved::list_saved))
        .route("/users/search", get(users::search_users))
        .route("/users/@me/dms", get(users::list_dms))
        .route("/users/@me/dms", post(users::open_dm))
        .route("/users/@me/group-dms", post(users::open_group_dm))
        .route(
            "/channels/{channel_id}/recipients",
            get(users::list_recipients),
        )
        .route("/users/@me/deadman", get(users::get_deadman))
        .route("/users/@me/deadman", post(users::set_deadman))
        // Profile
        .route("/users/@me/profile", get(profile::get_profile))
        .route("/users/@me/profile", patch(profile::update_profile))
        .route("/users/{user_id}/profile", get(profile::get_user_profile))
        .route("/users/@me/prefs", get(profile::get_prefs))
        .route("/users/@me/prefs", post(profile::set_prefs))
        // Encrypted E2E key backup (recovery-code model; server stores ciphertext only)
        .route("/users/@me/key-backup", get(profile::get_key_backup))
        .route("/users/@me/key-backup", put(profile::put_key_backup))
        .route("/users/@me/key-backup", delete(profile::delete_key_backup))
        // Servers
        .route("/servers", get(servers::list_servers))
        .route("/servers", post(servers::create_server))
        .route("/servers/{id}", get(servers::get_server))
        .route("/servers/{id}", delete(servers::delete_server))
        .route("/servers/{id}/join", post(servers::join_server))
        .route("/servers/{id}/leave", post(servers::leave_server))
        .route(
            "/servers/{server_id}/members/{user_id}",
            delete(servers::kick_member),
        )
        .route(
            "/servers/{server_id}/bans/{user_id}",
            post(servers::ban_member),
        )
        .route(
            "/servers/{server_id}/bans/{user_id}",
            delete(servers::unban_member),
        )
        .route("/servers/{server_id}/search", get(search::search_messages))
        // Scheduled events
        .route("/servers/{server_id}/events", get(events::list_events))
        .route("/servers/{server_id}/events", post(events::create_event))
        .route(
            "/servers/{server_id}/events/{event_id}/rsvp",
            post(events::rsvp_event),
        )
        .route(
            "/servers/{server_id}/events/{event_id}",
            delete(events::delete_event),
        )
        // Roles & permissions
        .route(
            "/servers/{server_id}/me/permissions",
            get(roles::my_permissions),
        )
        .route("/servers/{server_id}/roles", get(roles::list_roles))
        .route("/servers/{server_id}/roles", post(roles::create_role))
        .route(
            "/servers/{server_id}/roles/{role_id}",
            delete(roles::delete_role),
        )
        .route(
            "/servers/{server_id}/members/{user_id}/roles",
            get(roles::member_role_ids),
        )
        .route(
            "/servers/{server_id}/members/{user_id}/roles/{role_id}",
            put(roles::assign_role),
        )
        .route(
            "/servers/{server_id}/members/{user_id}/roles/{role_id}",
            delete(roles::unassign_role),
        )
        // Invites
        .route("/servers/{id}/invites", post(invites::create_invite))
        .route("/invites/{code}", get(invites::get_invite))
        .route("/invites/{code}", post(invites::redeem_invite))
        .route("/invites/{code}", delete(invites::revoke_invite))
        // Channels
        .route(
            "/servers/{server_id}/channels",
            get(channels::list_channels),
        )
        .route(
            "/servers/{server_id}/channels",
            post(channels::create_channel),
        )
        .route(
            "/servers/{server_id}/categories",
            post(channels::create_category),
        )
        .route(
            "/servers/{server_id}/categories/{category_id}",
            delete(channels::delete_category),
        )
        .route(
            "/servers/{server_id}/channels/{channel_id}/category",
            put(channels::set_channel_category),
        )
        .route("/channels/{id}", delete(channels::delete_channel))
        // Messages
        .route(
            "/channels/{channel_id}/messages",
            get(messages::list_messages),
        )
        .route(
            "/channels/{channel_id}/messages",
            post(messages::send_message),
        )
        .route("/channels/{channel_id}/reads", get(messages::list_reads))
        .route(
            "/channels/{channel_id}/disappearing",
            patch(messages::set_disappearing),
        )
        .route(
            "/channels/{channel_id}/sender-key",
            post(messages::distribute_sender_key),
        )
        .route("/channels/{channel_id}/watch", get(watch::get_watch))
        .route(
            "/channels/{channel_id}/messages/{id}",
            patch(messages::edit_message),
        )
        .route(
            "/channels/{channel_id}/messages/{id}",
            delete(messages::delete_message),
        )
        .route("/channels/{channel_id}/polls", post(polls::create_poll))
        .route(
            "/channels/{channel_id}/polls/{message_id}/vote",
            post(polls::vote_poll),
        )
        .route("/channels/{channel_id}/pins", get(messages::list_pins))
        .route(
            "/channels/{channel_id}/messages/{id}/pin",
            post(messages::pin_message),
        )
        .route(
            "/channels/{channel_id}/messages/{id}/pin",
            delete(messages::unpin_message),
        )
        .route(
            "/channels/{channel_id}/messages/{message_id}/save",
            post(saved::save_message),
        )
        .route(
            "/channels/{channel_id}/messages/{message_id}/save",
            delete(saved::unsave_message),
        )
        // Reactions — toggle with POST (idempotent add/remove)
        .route(
            "/channels/{channel_id}/messages/{message_id}/react/{emoji}",
            post(reactions::toggle_reaction),
        )
        // Files — large streaming uploads, capped at 2 GiB to bound disk-exhaustion DoS
        .route(
            "/upload",
            post(files::upload_file).layer(DefaultBodyLimit::max(2 * 1024 * 1024 * 1024)),
        )
        // Custom server emoji (Nitro-parity)
        .route("/servers/{server_id}/emojis", get(list_emojis))
        .route("/servers/{server_id}/emojis", post(create_emoji))
        .route(
            "/servers/{server_id}/emojis/{emoji_id}",
            delete(delete_emoji),
        )
        // Avatar upload
        .route("/users/@me/avatar", post(profile::set_avatar))
        // E2E encryption public-key directory (legacy static-key scheme)
        .route("/users/@me/key", post(keys::publish_key))
        .route("/users/{user_id}/key", get(keys::get_key))
        // Signal Protocol (X3DH) prekey directory — forward-secret sessions
        .route("/signal/keys", post(signal::publish_keys))
        .route("/signal/keys/count", get(signal::prekey_count))
        .route("/users/{user_id}/prekey-bundles", get(signal::get_bundles))
        // WebRTC ICE config: STUN + time-limited TURN credentials
        .route("/ice-servers", get(ice::ice_servers))
        // LiveKit SFU: feature-flagged config + room-scoped join tokens
        .route("/livekit/config", get(livekit::livekit_config))
        .route(
            "/channels/{channel_id}/livekit-token",
            post(livekit::create_livekit_token),
        )
        // Open Graph / link preview proxy (authenticated + SSRF-guarded)
        .route("/og", get(og::fetch_og))
        // One-time ticket to open the gateway WebSocket (keeps the JWT out of the URL)
        .route("/ws/ticket", post(crate::gateway::create_ws_ticket))
}
