//! Link-preview embeds — the january-style engine that turns URLs in a message
//! into resolved Open Graph cards. Reuses the SSRF-guarded fetcher in `og.rs`.
//!
//! Gated behind the `EMBEDS_ENABLED` env flag so it's opt-in (the network I/O it
//! does is server-initiated; off by default). The build is always non-blocking —
//! callers run it in a spawned task and broadcast a `MessageUpdate` when done.

use serde::{Deserialize, Serialize};

use crate::api::og::fetch_og_data;

/// Cap the work per message so a wall of links can't fan out unboundedly.
const MAX_URLS: usize = 5;

/// A resolved link-preview card persisted with a message and rendered by the client.
/// Field names mirror the client `Embed` type in `client/src/api.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Embed {
    pub url: String,
    /// "link" today; reserved for "image" / "video" specialisation later.
    pub embed_type: String,
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    pub site_name: Option<String>,
    pub favicon: Option<String>,
    pub color: Option<String>,
}

/// Runtime flag — only when `EMBEDS_ENABLED` is `true`/`1` do we fetch + persist.
pub fn embeds_enabled() -> bool {
    std::env::var("EMBEDS_ENABLED")
        .map(|v| v == "true" || v == "1")
        .unwrap_or(false)
}

/// Pull up to `MAX_URLS` distinct http(s) URLs out of message content, trimming
/// trailing punctuation that commonly hugs a link in prose.
pub fn extract_urls(content: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tok in content.split_whitespace() {
        if !(tok.starts_with("http://") || tok.starts_with("https://")) {
            continue;
        }
        let cleaned = tok
            .trim_end_matches(|c| {
                matches!(
                    c,
                    '.' | ',' | ')' | ']' | '}' | '!' | '?' | '"' | '\'' | '>'
                )
            })
            .to_owned();
        // Require something past the scheme and dedupe repeats.
        if cleaned.len() > 8 && !out.contains(&cleaned) {
            out.push(cleaned);
            if out.len() >= MAX_URLS {
                break;
            }
        }
    }
    out
}

/// Resolve every URL in `content` into an embed and serialise the array to JSON.
/// Returns `None` when there are no URLs or none resolved to a useful card —
/// the caller then leaves the message's `embeds` column NULL.
pub async fn build_embeds(content: &str) -> Option<String> {
    let urls = extract_urls(content);
    if urls.is_empty() {
        return None;
    }
    let mut embeds: Vec<Embed> = Vec::new();
    for url in urls {
        if let Some(og) = fetch_og_data(&url).await {
            // Skip bare cards with nothing to show.
            if og.title.is_none() && og.description.is_none() && og.image.is_none() {
                continue;
            }
            embeds.push(Embed {
                url: og.url,
                embed_type: "link".into(),
                title: og.title,
                description: og.description,
                image: og.image,
                site_name: og.site_name,
                favicon: og.favicon,
                color: None,
            });
        }
    }
    if embeds.is_empty() {
        return None;
    }
    serde_json::to_string(&embeds).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_dedupes_and_trims_urls() {
        let urls = extract_urls("see https://a.com, and https://b.com! plus https://a.com again");
        assert_eq!(
            urls,
            vec!["https://a.com".to_string(), "https://b.com".to_string()]
        );
    }

    #[test]
    fn ignores_non_links_and_bare_schemes() {
        assert!(extract_urls("just plain text, nothing here").is_empty());
        assert!(extract_urls("http://").is_empty());
    }

    #[test]
    fn caps_at_max_urls() {
        let many = (0..10)
            .map(|i| format!("https://site{i}.com"))
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(extract_urls(&many).len(), MAX_URLS);
    }

    #[test]
    fn embed_array_roundtrips() {
        let e = Embed {
            url: "https://x.com".into(),
            embed_type: "link".into(),
            title: Some("Title".into()),
            description: None,
            image: Some("https://x.com/i.png".into()),
            site_name: Some("X".into()),
            favicon: None,
            color: None,
        };
        let json = serde_json::to_string(&vec![e]).unwrap();
        let back: Vec<Embed> = serde_json::from_str(&json).unwrap();
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].title.as_deref(), Some("Title"));
        assert_eq!(back[0].embed_type, "link");
    }
}
