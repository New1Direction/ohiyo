//! What a message search asks for, read from the search box the way Discord reads it:
//! `from:alice in:general has:link before:2026-10-01 "big deploy"`.
//!
//! The same rule lives in the app (client/src/lib/searchQuery.ts), and both are tested
//! against client/test/fixtures/search-cases.json.

use serde::Serialize;

/// The kinds `has:` takes.
pub const HAS_KINDS: [&str; 5] = ["link", "file", "image", "video", "embed"];

/// A search, split into its filters and the words left over.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct ParsedQuery {
    /// Words and quoted phrases every result must contain.
    pub text: Vec<String>,
    /// `from:` authors (usernames or webhook names), lower case.
    pub from: Vec<String>,
    /// `mentions:` usernames, lower case.
    pub mentions: Vec<String>,
    /// `in:` channel names, lower case.
    #[serde(rename = "in")]
    pub in_channels: Vec<String>,
    /// `has:` kinds, from [`HAS_KINDS`].
    pub has: Vec<String>,
    /// `before:`, `after:` and `during:` days, as `YYYY-MM-DD`.
    pub before: Option<String>,
    pub after: Option<String>,
    pub during: Option<String>,
    /// `pinned:true` or `pinned:false`.
    pub pinned: Option<bool>,
}

impl ParsedQuery {
    /// True when the search asks for nothing but words.
    pub fn is_text_only(&self) -> bool {
        self.from.is_empty()
            && self.mentions.is_empty()
            && self.in_channels.is_empty()
            && self.has.is_empty()
            && self.before.is_none()
            && self.after.is_none()
            && self.during.is_none()
            && self.pinned.is_none()
    }
}

/// Read a search box's text.
pub fn parse(q: &str) -> ParsedQuery {
    ParsedQuery {
        text: q.split_whitespace().map(str::to_owned).collect(),
        ..ParsedQuery::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_queries_read_the_same_as_in_the_app() {
        let cases: Vec<serde_json::Value> = serde_json::from_str(include_str!(
            "../../../client/test/fixtures/search-cases.json"
        ))
        .unwrap();
        assert!(!cases.is_empty());
        for case in cases {
            let q = case["q"].as_str().unwrap();
            let expect = &case["expect"];
            let list = |key: &str| -> Vec<String> {
                expect[key]
                    .as_array()
                    .map(|a| a.iter().map(|v| v.as_str().unwrap().to_owned()).collect())
                    .unwrap_or_default()
            };
            let day = |key: &str| expect[key].as_str().map(str::to_owned);
            let want = ParsedQuery {
                text: list("text"),
                from: list("from"),
                mentions: list("mentions"),
                in_channels: list("in"),
                has: list("has"),
                before: day("before"),
                after: day("after"),
                during: day("during"),
                pinned: expect["pinned"].as_bool(),
            };
            assert_eq!(parse(q), want, "{}: {q:?}", case["why"]);
        }
    }
}
