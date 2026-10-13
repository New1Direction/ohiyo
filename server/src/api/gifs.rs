//! GIF search through KLIPY. Stub: server/tests/gifs.rs describes what it must do.

use std::time::Duration;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::{auth::AuthUser, AppState};

pub const KLIPY_API: &str = "https://api.klipy.com";
const KLIPY_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Clone)]
pub struct Klipy {
    pub api_key: String,
    pub base_url: String,
    pub timeout: Duration,
    pub client: reqwest::Client,
}

impl Klipy {
    pub fn new(api_key: impl Into<String>) -> Self {
        Klipy {
            api_key: api_key.into(),
            base_url: KLIPY_API.to_owned(),
            timeout: KLIPY_TIMEOUT,
            client: reqwest::Client::new(),
        }
    }

    pub fn from_env() -> Option<Self> {
        None
    }

    pub fn with_base_url(mut self, base_url: impl Into<String>) -> Self {
        self.base_url = base_url.into();
        self
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }
}

impl std::fmt::Debug for Klipy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Klipy")
            .field("api_key", &"<redacted>")
            .field("base_url", &self.base_url)
            .finish()
    }
}

#[derive(Deserialize)]
pub struct SearchParams {
    pub q: Option<String>,
    pub page: Option<u32>,
}

#[derive(Deserialize)]
pub struct PageParams {
    pub page: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct Gif {
    pub id: String,
    pub title: String,
    pub url: String,
    pub preview: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Serialize)]
pub struct GifPage {
    pub available: bool,
    pub results: Vec<Gif>,
    pub page: u32,
    pub has_next: bool,
}

fn unavailable() -> GifPage {
    GifPage {
        available: false,
        results: Vec::new(),
        page: 1,
        has_next: false,
    }
}

pub async fn search(
    _auth: AuthUser,
    State(_state): State<AppState>,
    Query(_params): Query<SearchParams>,
) -> Result<Json<GifPage>, (StatusCode, String)> {
    Ok(Json(unavailable()))
}

pub async fn trending(
    _auth: AuthUser,
    State(_state): State<AppState>,
    Query(_params): Query<PageParams>,
) -> Result<Json<GifPage>, (StatusCode, String)> {
    Ok(Json(unavailable()))
}
