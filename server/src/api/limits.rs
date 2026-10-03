//! Length caps for user-supplied text that is stored and then fanned out to other users
//! (member lists, Ready payloads, every message). Lengths count characters (Unicode
//! scalar values), not bytes, so a cap means the same in every script. Rows written
//! before these caps existed are left as they are.

use axum::http::StatusCode;

pub const DISPLAY_NAME: usize = 64;
pub const SERVER_NAME: usize = 100;
pub const CHANNEL_NAME: usize = 100;
pub const CHANNEL_TOPIC: usize = 1024;
pub const ROLE_NAME: usize = 100;
pub const EVENT_TITLE: usize = 200;
pub const EVENT_DESCRIPTION: usize = 4000;
pub const POLL_OPTION: usize = 200;

/// Reject `value` with 400 when it is longer than `max` characters.
pub fn check_len(field: &str, value: &str, max: usize) -> Result<(), (StatusCode, String)> {
    if value.chars().count() > max {
        return Err((
            StatusCode::BAD_REQUEST,
            format!("{field} is too long (max {max} characters)"),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_characters_not_bytes() {
        assert!(check_len("name", &"é".repeat(3), 3).is_ok());
        assert!(check_len("name", &"é".repeat(4), 3).is_err());
        assert!(check_len("name", "", 0).is_ok());
    }
}
