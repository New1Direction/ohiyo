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

/// Longest `from:`/`mentions:` value (a webhook's name can be 64 characters).
const MAX_NAME_CHARS: usize = 64;
/// Longest `in:` value (a channel or thread name).
const MAX_CHANNEL_CHARS: usize = 100;

/// One word of the box: its text with the quotes taken out, and whether it began with a
/// quote (a quoted word is always text, never a filter).
struct Token {
    text: String,
    quoted: bool,
}

/// Split the box into words. Whitespace separates words outside quotes; a `"` opens or
/// closes a quoted run inside a word, so `in:"release notes"` is one word; an unclosed quote
/// runs to the end. Whitespace is Rust's [`char::is_whitespace`]; the app uses the same set.
fn tokens(q: &str) -> Vec<Token> {
    let mut out = Vec::new();
    let mut chars = q.chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| c.is_whitespace()) {
            chars.next();
        }
        let Some(&first) = chars.peek() else {
            break;
        };
        let mut text = String::new();
        let mut in_quote = false;
        while let Some(&c) = chars.peek() {
            if c == '"' {
                in_quote = !in_quote;
            } else if !in_quote && c.is_whitespace() {
                break;
            } else {
                text.push(c);
            }
            chars.next();
        }
        if !text.is_empty() {
            out.push(Token {
                text,
                quoted: first == '"',
            });
        }
    }
    out
}

/// `YYYY-MM-DD` naming a day that exists.
fn is_day(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
        && chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").is_ok()
}

fn push_once(list: &mut Vec<String>, value: String) {
    if !list.contains(&value) {
        list.push(value);
    }
}

/// Read a search box's text. A word `key:value` with a known key and a value that fits is a
/// filter; anything else (an unknown key, an empty or impossible value, a quoted word) is
/// text. `from:`, `mentions:`, `in:` and `has:` add up (each value once); for the dates and
/// `pinned:` the last one wins.
pub fn parse(q: &str) -> ParsedQuery {
    let mut out = ParsedQuery::default();
    for Token { text, quoted } in tokens(q) {
        let filter = if quoted { None } else { text.split_once(':') };
        let Some((key, value)) = filter else {
            out.text.push(text);
            continue;
        };
        let value = value.trim();
        let used = match key.to_lowercase().as_str() {
            "from" | "mentions" => {
                let name = value.strip_prefix('@').unwrap_or(value).to_lowercase();
                let fits = !name.is_empty() && name.chars().count() <= MAX_NAME_CHARS;
                if fits {
                    let list = if key.eq_ignore_ascii_case("from") {
                        &mut out.from
                    } else {
                        &mut out.mentions
                    };
                    push_once(list, name);
                }
                fits
            }
            "in" => {
                let name = value.strip_prefix('#').unwrap_or(value).to_lowercase();
                let fits = !name.is_empty() && name.chars().count() <= MAX_CHANNEL_CHARS;
                if fits {
                    push_once(&mut out.in_channels, name);
                }
                fits
            }
            "has" => {
                let kind = value.to_lowercase();
                let fits = HAS_KINDS.contains(&kind.as_str());
                if fits {
                    push_once(&mut out.has, kind);
                }
                fits
            }
            day @ ("before" | "after" | "during") => {
                let fits = is_day(value);
                if fits {
                    let slot = match day {
                        "before" => &mut out.before,
                        "after" => &mut out.after,
                        _ => &mut out.during,
                    };
                    *slot = Some(value.to_owned());
                }
                fits
            }
            "pinned" => match value.to_lowercase().as_str() {
                "true" => {
                    out.pinned = Some(true);
                    true
                }
                "false" => {
                    out.pinned = Some(false);
                    true
                }
                _ => false,
            },
            _ => false,
        };
        if !used {
            out.text.push(text);
        }
    }
    out
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
