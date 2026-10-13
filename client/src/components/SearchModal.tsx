import { useEffect, useMemo, useRef, useState } from "react";
import type { Channel, Message, PublicUser, SearchChannel, SearchPage } from "../api";
import { ModalShell } from "./ModalShell";
import { avatarStyle } from "../lib/avatarStyle";
import { formatFullTime, formatMessageTime } from "../lib/messageTime";
import {
  applySuggestion,
  chipsOf,
  highlightParts,
  isEmptySearch,
  parseSearch,
  suggestionsFor,
  withoutChip,
  type SearchChip,
  type Suggestions,
} from "../lib/searchQuery";

/** A result to go to: the message, its channel, and the channel a thread hangs off. */
export type SearchHit = { id: string; channel_id: string; thread_parent_id: string | null };

type Props = {
  /** The space's channels (threads aren't listed; they come with results). */
  channels: Channel[];
  /** The space's people, offered for from: and mentions:. */
  members: PublicUser[];
  /** Ask the server for a page of results. */
  search: (q: string, page: { offset: number; limit: number }) => Promise<SearchPage>;
  onJumpToMessage: (hit: SearchHit) => void;
  onClose: () => void;
  /** A stored picture URL resolved against the home's file server. */
  assetUrl?: (stored: string) => string;
  /** Now, in ms (tests pin it). */
  now?: () => number;
};

const PAGE = 25;
const DEBOUNCE_MS = 220;
const LISTBOX_ID = "kc-search-suggestions";

const CHIP_LABEL: Record<SearchChip["key"], string> = {
  from: "From",
  mentions: "Mentions",
  in: "In",
  has: "Has",
  before: "Before",
  after: "After",
  during: "During",
  pinned: "Pinned",
};

type Results = { messages: Message[]; channels: Map<string, SearchChannel>; total: number; capped: boolean };

/** Search a space's messages like Discord, and go to a result. */
export function SearchModal({ channels, members, search, onJumpToMessage, onClose, assetUrl, now = Date.now }: Props) {
  const [q, setQ] = useState("");
  const [caret, setCaret] = useState(0);
  const [results, setResults] = useState<Results | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [suggestionsClosed, setSuggestionsClosed] = useState(false);
  const boxRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef(search);
  searchRef.current = search;

  const parsed = useMemo(() => parseSearch(q), [q]);
  const chips = useMemo(() => chipsOf(q), [q]);
  const suggestions: Suggestions | null = useMemo(
    () => (suggestionsClosed ? null : suggestionsFor(q, caret, { members, channels, now: now() })),
    [q, caret, members, channels, suggestionsClosed, now],
  );
  const open = suggestions !== null && suggestions.items.length > 0;

  useEffect(() => setActive(0), [suggestions]);

  // Search as the box changes, a moment after typing stops.
  useEffect(() => {
    const term = q.trim();
    if (!term || isEmptySearch(parsed)) {
      setResults(null);
      setLoading(false);
      setError(null);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    const id = setTimeout(() => {
      searchRef.current(term, { offset: 0, limit: PAGE })
        .then((page) => {
          if (!alive) return;
          setResults({
            messages: page.messages,
            channels: new Map(page.channels.map((c) => [c.id, c])),
            total: page.total,
            capped: page.total_capped,
          });
        })
        .catch(() => {
          if (!alive) return;
          setResults(null);
          setError("Search couldn't load. Check your connection and try again.");
        })
        .finally(() => alive && setLoading(false));
    }, DEBOUNCE_MS);
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [q, parsed]);

  function loadMore() {
    if (!results) return;
    setLoadingMore(true);
    searchRef.current(q.trim(), { offset: results.messages.length, limit: PAGE })
      .then((page) =>
        setResults((prev) =>
          prev && {
            messages: [...prev.messages, ...page.messages.filter((m) => !prev.messages.some((p) => p.id === m.id))],
            channels: new Map([...prev.channels, ...page.channels.map((c) => [c.id, c] as const)]),
            total: page.total,
            capped: page.total_capped,
          },
        ),
      )
      .catch(() => setError("Search couldn't load. Check your connection and try again."))
      .finally(() => setLoadingMore(false));
  }

  function setBox(value: string, at: number) {
    setQ(value);
    setCaret(at);
    setSuggestionsClosed(false);
    window.requestAnimationFrame(() => {
      const box = boxRef.current;
      if (!box) return;
      box.focus();
      box.setSelectionRange(at, at);
    });
  }

  function pick(index: number) {
    if (!suggestions) return;
    const item = suggestions.items[index];
    if (!item) return;
    const next = applySuggestion(q, suggestions, item);
    setBox(next.value, next.caret);
  }

  function jump(m: Message) {
    const channel = results?.channels.get(m.channel_id);
    onJumpToMessage({ id: m.id, channel_id: m.channel_id, thread_parent_id: channel?.parent_id ?? null });
    onClose();
  }

  function onBoxKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (open && suggestions) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = suggestions.items.length;
        setActive((i) => (e.key === "ArrowDown" ? (i + 1) % n : (i - 1 + n) % n));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pick(active);
        return;
      }
      if (e.key === "Escape") {
        // Close the suggestions, not the sheet.
        e.preventDefault();
        e.stopPropagation();
        setSuggestionsClosed(true);
        return;
      }
    }
    if (e.key === "ArrowDown") {
      const first = resultsRef.current?.querySelector<HTMLButtonElement>(".kc-search-result button");
      if (first) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  // Up and down move between results' Jump buttons; Up from the first goes back to the box.
  function onResultsKey(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const buttons = [...(resultsRef.current?.querySelectorAll<HTMLButtonElement>(".kc-search-result button") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    e.preventDefault();
    if (e.key === "ArrowUp" && at === 0) boxRef.current?.focus();
    else buttons[Math.min(buttons.length - 1, Math.max(0, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  }

  const groups = useMemo(() => {
    const out: { id: string; messages: Message[] }[] = [];
    for (const m of results?.messages ?? []) {
      const g = out.find((x) => x.id === m.channel_id);
      if (g) g.messages.push(m);
      else out.push({ id: m.channel_id, messages: [m] });
    }
    return out;
  }, [results]);

  const nowMs = now();
  const count = results ? `${results.capped ? "100+" : results.total} ${results.total === 1 && !results.capped ? "result" : "results"}` : "";
  const more = results ? results.messages.length < (results.capped ? 1000 : results.total) : false;

  return (
    <ModalShell onClose={onClose} labelledBy="kc-search-title" maxWidthClass="max-w-xl kc-search-sheet">
      <h2 id="kc-search-title" className="kc-search-title">
        Search messages
      </h2>
      <div className="kc-search-field">
        <input
          ref={boxRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
            setSuggestionsClosed(false);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? q.length)}
          onKeyDown={onBoxKey}
          onBlur={() => setSuggestionsClosed(true)}
          onFocus={() => setSuggestionsClosed(false)}
          placeholder="Search, or try from:, in:, has:"
          aria-label="Search messages"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={LISTBOX_ID}
          aria-activedescendant={open ? `${LISTBOX_ID}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          className="kc-field w-full px-3.5 py-3 text-sm outline-none"
        />
        {open && suggestions && (
          <ul id={LISTBOX_ID} role="listbox" aria-label="Suggestions" className="kc-search-suggestions">
            {suggestions.items.map((item, i) => {
              const person = item.avatarOf ? members.find((m) => m.id === item.avatarOf) : undefined;
              return (
                <li
                  key={item.insert}
                  id={`${LISTBOX_ID}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  tabIndex={-1}
                  className={`kc-search-suggestion${i === active ? " is-active" : ""}`}
                  // Keep focus in the box: pick on mouse down, before the box would blur.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(i);
                  }}
                >
                  {person && (
                    <span
                      className="kc-search-avatar"
                      style={avatarStyle(person.id, person.avatar_url && assetUrl ? assetUrl(person.avatar_url) : null)}
                      aria-hidden="true"
                    />
                  )}
                  <span className="kc-search-suggestion__label">{item.label}</span>
                  {item.detail && <span className="kc-search-suggestion__detail">{item.detail}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {chips.length > 0 && (
        <ul className="kc-search-chips" aria-label="Filters">
          {chips.map((chip) => (
            <li key={`${chip.start}-${chip.key}`} className="kc-search-chip">
              <span>
                {CHIP_LABEL[chip.key]}: <b>{chip.key === "in" ? `#${chip.value}` : chip.value}</b>
              </span>
              <button
                type="button"
                className="kc-search-chip__remove"
                aria-label={`Remove ${CHIP_LABEL[chip.key].toLowerCase()} ${chip.value}`}
                onClick={() => {
                  const next = withoutChip(q, chip);
                  setBox(next, next.length);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- arrow keys move between the Jump buttons inside */}
      <div ref={resultsRef} className="kc-search-results" onKeyDown={onResultsKey}>
        {loading ? (
          <div className="flex flex-col gap-2" aria-label="Searching">
            {[0, 1, 2].map((i) => <div key={i} className="kc-skeleton" style={{ height: 56 }} />)}
          </div>
        ) : error ? (
          <Hint text={error} />
        ) : !results ? (
          <Hint text="Search this space. Filters: from:, mentions:, in:, has:, before:, after:, during:, pinned:." />
        ) : results.messages.length === 0 ? (
          <Hint text="No messages match." />
        ) : (
          <>
            <p className="kc-search-count" aria-live="polite">{count}</p>
            {groups.map((g) => {
              const channel = results.channels.get(g.id);
              return (
                <section key={g.id} className="kc-search-group" aria-label={channelTitle(channel)}>
                  <h3 className="kc-search-group__title">
                    {channel?.parent_id ? (
                      <>
                        <b>{channel.name}</b> in #{channel.parent_name}
                      </>
                    ) : (
                      <>#{channel?.name ?? "channel"}</>
                    )}
                  </h3>
                  <ul>
                    {g.messages.map((m) => (
                      <li key={m.id} className="kc-search-result">
                        <span
                          className="kc-search-avatar"
                          style={avatarStyle(m.author.id, m.author.avatar_url && assetUrl ? assetUrl(m.author.avatar_url) : null)}
                          aria-hidden="true"
                        />
                        <div className="kc-search-result__body">
                          <div className="kc-search-result__meta">
                            <span className="kc-search-result__author">{m.author.display_name || m.author.username}</span>
                            <time dateTime={new Date(m.created_at * 1000).toISOString()} title={formatFullTime(m.created_at * 1000)}>
                              {formatMessageTime(m.created_at * 1000, nowMs)}
                            </time>
                          </div>
                          <p className="kc-search-result__text">
                            {m.content
                              ? highlightParts(m.content, parsed.text).map((part, i) =>
                                  part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
                                )
                              : "(attachment)"}
                          </p>
                        </div>
                        <button type="button" className="kc-search-result__jump" onClick={() => jump(m)}>
                          Jump
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
            {more && (
              <button type="button" className="kc-search-more" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? "Loading…" : "Show more results"}
              </button>
            )}
          </>
        )}
      </div>
    </ModalShell>
  );
}

function channelTitle(channel: SearchChannel | undefined): string {
  if (!channel) return "Channel";
  return channel.parent_id ? `${channel.name} in #${channel.parent_name}` : `#${channel.name}`;
}

function Hint({ text }: { text: string }) {
  return <div className="kc-search-hint">{text}</div>;
}
