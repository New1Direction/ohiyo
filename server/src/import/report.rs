//! The transparency artifact every import returns: what mapped, what needs human
//! review, what was parked. Nothing is silently dropped.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ImportReport {
    pub categories: u32,
    pub channels: u32,
    pub authors: u32,
    pub messages: u32,
    pub reactions: u32,
    pub attachments: u32,
    /// Role names recreated name+color only — the operator must set permissions.
    pub roles_needing_review: Vec<String>,
    /// Human-readable notes for anything not faithfully representable in Ohiyo.
    pub parked: Vec<String>,
}

impl ImportReport {
    pub fn note_parked(&mut self, note: &str) {
        self.parked.push(note.to_string());
    }
    pub fn flag_role_review(&mut self, role_name: &str) {
        self.roles_needing_review.push(role_name.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulates_counts_and_notes() {
        let mut r = ImportReport {
            channels: 3,
            ..Default::default()
        };
        r.flag_role_review("Mod");
        r.note_parked("2 stickers dropped");
        assert_eq!(r.channels, 3);
        assert_eq!(r.roles_needing_review, vec!["Mod"]);
        assert_eq!(r.parked.len(), 1);
    }

    #[test]
    fn serializes_to_json() {
        let json = serde_json::to_string(&ImportReport::default()).unwrap();
        assert!(json.contains("\"messages\":0"));
    }
}
