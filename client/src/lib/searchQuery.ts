// What a message search asks for, read from the search box the way Discord reads it:
// `from:alice in:general has:link before:2026-10-01 "big deploy"`. The server reads the box
// with the same rule (server/src/api/search_query.rs); both are tested against
// client/test/fixtures/search-cases.json.

export const SEARCH_KEYS = ["from", "mentions", "in", "has", "before", "after", "during", "pinned"] as const;
export type SearchKey = (typeof SEARCH_KEYS)[number];
export const HAS_KINDS = ["link", "file", "image", "video", "embed"] as const;

export type ParsedSearch = {
  text: string[];
  from: string[];
  mentions: string[];
  in: string[];
  has: string[];
  before: string | null;
  after: string | null;
  during: string | null;
  pinned: boolean | null;
};

/** Read a search box's text. */
export function parseSearch(q: string): ParsedSearch {
  return {
    text: q.split(/\s+/).filter(Boolean),
    from: [],
    mentions: [],
    in: [],
    has: [],
    before: null,
    after: null,
    during: null,
    pinned: null,
  };
}

export type SuggestionItem = { label: string; detail?: string; insert: string; avatarOf?: string };
export type Suggestions = { from: number; to: number; items: SuggestionItem[] };
export type SuggestionContext = {
  members: { id: string; username: string; display_name: string }[];
  channels: { name: string }[];
  /** Now, in ms; dates are suggested in the person's own day. */
  now: number;
};

/** What to offer for the word under the caret. Null when there's nothing to suggest. */
export function suggestionsFor(_value: string, _caret: number, _ctx: SuggestionContext): Suggestions | null {
  return null;
}

/** Put a suggestion in place of the word it was offered for. */
export function applySuggestion(value: string, _s: Suggestions, _item: SuggestionItem): { value: string; caret: number } {
  return { value, caret: value.length };
}

/** `text` cut into the parts that match one of `terms` (any case) and the parts between. */
export function highlightParts(text: string, _terms: string[]): { text: string; hit: boolean }[] {
  return [{ text, hit: false }];
}
