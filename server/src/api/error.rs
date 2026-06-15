//! Shared error mapping. Internal failures (DB, IO, crypto) are LOGGED server-side with
//! full detail but returned to the client as a generic message — raw `sqlx`/IO error
//! strings leak schema, column, constraint, and file-path details and must never reach
//! an HTTP response body.

use axum::http::StatusCode;

/// Log the real error and return a generic 500 to the client.
pub fn internal<E: std::fmt::Display>(e: E) -> (StatusCode, String) {
    tracing::error!(error = %e, "internal server error");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        "internal error".to_owned(),
    )
}
