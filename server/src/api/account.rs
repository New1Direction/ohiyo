//! Deleting an account, for good and at once.
//!
//! What goes, and what happens to what others still use:
//! - Every message the user sent is deleted, for everyone (as the dead-man's switch does).
//! - A space they own goes to its longest-standing other member; one with no other
//!   members is deleted with everything in it.
//! - A group DM they own goes to the next member, and the group rekeys.
//! - Custom emoji they added to someone else's space stay, credited to that space's owner.
//! - A file they uploaded that others still use (a shared upload, a space icon) stays,
//!   credited to someone who uses it. Every other upload is deleted.
//! - Their Instant Servers are destroyed (machine and volume) before anything else, so a
//!   failure there leaves the account as it was.
//! - Their encryption keys, key backup and sessions go. Their username is free again.

use std::time::Duration;

use axum::{extract::State, http::StatusCode, Json};
use serde::Deserialize;

use crate::{
    api::{
        auth::run_argon2,
        error::internal,
        files::{
            attachment_file_ids, delete_unreferenced_files, release_files_in_batches, remove_blobs,
        },
        servers::broadcast_full_server_to_members,
        users::{broadcast_members, bump_epoch},
    },
    auth::{verify_password, AuthUser},
    gateway::broadcast_to_server,
    types::{GatewayEvent, User},
    AppState,
};

/// Attempts per minute per account: each costs an Argon2 verify, and someone holding a
/// stolen session must not be able to guess the password quickly.
const DELETE_ACCOUNT_MAX_PER_MIN: usize = 5;

#[derive(Deserialize)]
pub struct DeleteAccountBody {
    pub password: String,
    /// Typed by hand, so a slip of the mouse can't delete an account.
    pub username: String,
}

/// DELETE /users/@me — delete the caller's account. Needs the password and the username.
pub async fn delete_account(
    auth: AuthUser,
    State(state): State<AppState>,
    Json(body): Json<DeleteAccountBody>,
) -> Result<StatusCode, (StatusCode, String)> {
    if !state.rate.check(
        &format!("delete-account:{}", auth.0),
        DELETE_ACCOUNT_MAX_PER_MIN,
        Duration::from_secs(60),
    ) {
        return Err((
            StatusCode::TOO_MANY_REQUESTS,
            "too many attempts — give it a moment and try again".into(),
        ));
    }
    let user: User = sqlx::query_as("SELECT * FROM users WHERE id = ?")
        .bind(&auth.0)
        .fetch_optional(&state.db)
        .await
        .map_err(internal)?
        .ok_or((StatusCode::UNAUTHORIZED, "invalid session".into()))?;
    if body.username != user.username {
        return Err((
            StatusCode::BAD_REQUEST,
            "type your username exactly to confirm".into(),
        ));
    }
    let (password, hash) = (body.password, user.password_hash.clone());
    if !run_argon2(move || verify_password(&password, &hash)).await? {
        // 403, not 401: the session is fine, the password isn't.
        return Err((StatusCode::FORBIDDEN, "password is wrong".into()));
    }
    let me = auth.0;

    // Instant Servers run on real machines: destroy them first. If the cloud refuses,
    // stop here with the account intact, so the user can try again.
    let instances: Vec<String> =
        sqlx::query_scalar("SELECT id FROM hosted_instances WHERE owner_id = ?")
            .bind(&me)
            .fetch_all(&state.db)
            .await
            .map_err(internal)?;
    for id in &instances {
        crate::provision::delete_instance(&state.db, state.provisioner.as_ref(), &me, id).await?;
    }

    let plan = plan(&state, &me).await.map_err(internal)?;
    let (attachment_ids, orphaned_blobs) = remove_everything(&state, &me, &plan)
        .await
        .map_err(internal)?;
    remove_blobs(orphaned_blobs).await;
    // Files attached to their messages that someone else uploaded: free them if unused.
    release_files_in_batches(&state.db, &attachment_ids).await;

    // Their sessions end: every socket closes (the user row is gone, so tokens fail too).
    state
        .sessions
        .write()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&me);
    for (server_id, _) in &plan.handed_over {
        broadcast_full_server_to_members(&state, server_id).await;
    }
    for server_id in &plan.member_of {
        broadcast_to_server(
            &state,
            server_id,
            &GatewayEvent::MemberLeave {
                server_id: server_id.clone(),
                user_id: me.clone(),
            },
        )
        .await;
    }
    for channel_id in &plan.groups {
        // The rest of the group rotates its keys, as when anyone leaves.
        if let Ok(epoch) = bump_epoch(&state, channel_id).await {
            broadcast_members(&state, channel_id, epoch).await;
        }
    }
    tracing::info!(user_id = %me, "account deleted");
    Ok(StatusCode::NO_CONTENT)
}

/// What happens to the spaces and groups the user is in, worked out before anything is
/// deleted (the cascade removes the memberships these come from).
struct Plan {
    /// Owned spaces with another member: (space, new owner).
    handed_over: Vec<(String, String)>,
    /// Owned spaces with nobody else in them.
    deleted: Vec<String>,
    /// Spaces they were only a member of.
    member_of: Vec<String>,
    /// Group DMs they were in.
    groups: Vec<String>,
}

async fn plan(state: &AppState, me: &str) -> Result<Plan, sqlx::Error> {
    let owned: Vec<String> = sqlx::query_scalar("SELECT id FROM servers WHERE owner_id = ?")
        .bind(me)
        .fetch_all(&state.db)
        .await?;
    let mut handed_over = Vec::new();
    let mut deleted = Vec::new();
    for server_id in owned {
        // The longest-standing other member; rowid breaks a tie in joined_at.
        let next: Option<String> = sqlx::query_scalar(
            "SELECT user_id FROM server_members WHERE server_id = ? AND user_id != ?
             ORDER BY joined_at, rowid LIMIT 1",
        )
        .bind(&server_id)
        .bind(me)
        .fetch_optional(&state.db)
        .await?;
        match next {
            Some(owner) => handed_over.push((server_id, owner)),
            None => deleted.push(server_id),
        }
    }
    let member_of: Vec<String> = sqlx::query_scalar(
        "SELECT m.server_id FROM server_members m JOIN servers s ON s.id = m.server_id
         WHERE m.user_id = ? AND s.owner_id != ?",
    )
    .bind(me)
    .bind(me)
    .fetch_all(&state.db)
    .await?;
    let groups: Vec<String> = sqlx::query_scalar(
        "SELECT c.id FROM channels c JOIN dm_participants p ON p.channel_id = c.id
         WHERE p.user_id = ? AND c.channel_type = 'group_dm'",
    )
    .bind(me)
    .fetch_all(&state.db)
    .await?;
    Ok(Plan {
        handed_over,
        deleted,
        member_of,
        groups,
    })
}

/// Everything in one transaction, so a failure leaves the account as it was. Returns the
/// file ids attached to their deleted messages, and the blobs no file row points at now.
async fn remove_everything(
    state: &AppState,
    me: &str,
    plan: &Plan,
) -> Result<(Vec<String>, Vec<String>), sqlx::Error> {
    let mut tx = state.db.begin().await?;

    // Their messages, everywhere.
    let attachments: Vec<String> = sqlx::query_scalar(
        "SELECT attachments FROM messages WHERE author_id = ? AND attachments IS NOT NULL",
    )
    .bind(me)
    .fetch_all(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM messages WHERE author_id = ?")
        .bind(me)
        .execute(&mut *tx)
        .await?;
    // Their own avatar and banner no longer count as uses of a file.
    sqlx::query("UPDATE users SET avatar_url = NULL, banner_url = NULL WHERE id = ?")
        .bind(me)
        .execute(&mut *tx)
        .await?;

    // Spaces they own.
    for (server_id, owner) in &plan.handed_over {
        sqlx::query("UPDATE servers SET owner_id = ? WHERE id = ?")
            .bind(owner)
            .bind(server_id)
            .execute(&mut *tx)
            .await?;
    }
    for server_id in &plan.deleted {
        sqlx::query("DELETE FROM servers WHERE id = ?")
            .bind(server_id)
            .execute(&mut *tx)
            .await?;
    }
    // Emoji they added to spaces that stay: the space keeps them, credited to its owner.
    sqlx::query(
        "UPDATE server_emojis SET created_by = (SELECT owner_id FROM servers s WHERE s.id = server_emojis.server_id)
         WHERE created_by = ?",
    )
    .bind(me)
    .execute(&mut *tx)
    .await?;

    // Group DMs: leave, and hand ownership on as leaving does (NULL when nobody is left).
    sqlx::query("DELETE FROM dm_participants WHERE user_id = ?")
        .bind(me)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE channels SET owner_id = (SELECT p.user_id FROM dm_participants p
             WHERE p.channel_id = channels.id ORDER BY p.rowid LIMIT 1)
         WHERE owner_id = ? AND channel_type = 'group_dm'",
    )
    .bind(me)
    .execute(&mut *tx)
    .await?;

    // Rows that point at them without cascading, or with no foreign key at all.
    for sql in [
        "DELETE FROM discord_imports WHERE owner_id = ?",
        "DELETE FROM user_prefs WHERE user_id = ?",
        "DELETE FROM signal_one_time_prekeys WHERE user_id = ?",
        "DELETE FROM signal_identity WHERE user_id = ?",
        "DELETE FROM signal_device_tombstones WHERE user_id = ?",
        "DELETE FROM key_backups WHERE user_id = ?",
        "DELETE FROM channel_reads WHERE user_id = ?",
        "DELETE FROM device_link_tokens WHERE user_id = ?",
    ] {
        sqlx::query(sql).bind(me).execute(&mut *tx).await?;
    }

    // Their uploads: delete the ones nothing uses any more; credit the rest to someone
    // who still uses them (a message's author, a space's owner, a profile).
    let uploads: Vec<String> = sqlx::query_scalar("SELECT id FROM files WHERE uploader_id = ?")
        .bind(me)
        .fetch_all(&mut *tx)
        .await?;
    let orphaned_blobs = delete_unreferenced_files(&mut tx, &uploads).await?;
    sqlx::query(
        "UPDATE files SET uploader_id = COALESCE(
             (SELECT m.author_id FROM messages m WHERE instr(m.attachments, files.id) > 0
                ORDER BY m.created_at LIMIT 1),
             (SELECT s.owner_id FROM servers s WHERE instr(s.icon_url, '/files/' || files.id) > 0 LIMIT 1),
             (SELECT s.owner_id FROM server_emojis e JOIN servers s ON s.id = e.server_id
                WHERE e.file_id = files.id LIMIT 1),
             (SELECT u.id FROM users u WHERE u.id != ?1 AND (instr(u.avatar_url, '/files/' || files.id) > 0
                OR instr(u.banner_url, '/files/' || files.id) > 0) LIMIT 1))
         WHERE uploader_id = ?1",
    )
    .bind(me)
    .execute(&mut *tx)
    .await?;

    // The account itself; the rest (memberships, reactions, friends, devices…) cascades.
    sqlx::query("DELETE FROM users WHERE id = ?")
        .bind(me)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let attachment_ids = attachments
        .iter()
        .flat_map(|raw| attachment_file_ids(Some(raw)))
        .collect();
    Ok((attachment_ids, orphaned_blobs))
}
