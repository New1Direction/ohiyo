import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Channel, ServerWithChannels } from "../api";

export type CommandAction = {
  id: string;
  label: string;
  sub: string;
  icon: string;
  run: () => void;
};

type Result = {
  id: string;
  label: string;
  sub: string;
  icon: string;
  serverIconUrl?: string | null;
} & ({ kind: "channel"; channel: Channel } | { kind: "action"; run: () => void });

type Props = {
  servers: ServerWithChannels[];
  dms: Channel[];
  actions?: CommandAction[];
  onSelectChannel: (channel: Channel) => void;
  onClose: () => void;
};

export function CommandPalette({ servers, dms, actions = [], onSelectChannel, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Build flat list of all channels + DMs.
  const allChannels: Result[] = [
    ...dms.map((ch) => ({
      id: ch.id,
      label: ch.name === "dm" ? "Direct Message" : ch.name,
      sub: "DM",
      icon: "👤",
      kind: "channel" as const,
      channel: ch,
    })),
    ...servers.flatMap((s) =>
      s.channels.map((ch) => ({
        id: ch.id,
        label: ch.name,
        sub: s.name,
        icon: ch.channel_type === "voice" ? "🔊" : "#",
        serverIconUrl: s.icon_url,
        kind: "channel" as const,
        channel: ch,
      }))
    ),
  ];

  const allActions: Result[] = actions.map((action) => ({ ...action, kind: "action" as const }));
  const searchable = [...allActions, ...allChannels];
  const q = query.toLowerCase().trim();
  const results = q
    ? searchable.filter(
        (r) =>
          r.label.toLowerCase().includes(q) ||
          r.sub.toLowerCase().includes(q)
      )
    : searchable.slice(0, 10);

  const clampedIdx = Math.min(activeIdx, Math.max(0, results.length - 1));

  function select(r: Result) {
    if (r.kind === "action") r.run();
    else onSelectChannel(r.channel);
    onClose();
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const r = results[clampedIdx];
      if (r) select(r);
    }
  }

  // Scroll active item into view.
  useEffect(() => {
    const el = listRef.current?.children[clampedIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [clampedIdx]);

  const palette = (
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- modal scrim; backdrop click dismisses, Escape closes via key handler
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Quick switcher"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "15vh",
        background: "color-mix(in oklch, var(--text-primary) 36%, transparent)",
        backdropFilter: "blur(2px)",
      }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: 520,
          borderRadius: "var(--radius-xl)",
          overflow: "hidden",
          boxShadow: "var(--shadow-lg)",
          background: "var(--bg-sidebar)",
          border: "1px solid var(--bg-hover)",
        }}
      >
        {/* Search input */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 16px",
            borderBottom: "1px solid var(--bg-hover)",
          }}
        >
          <span style={{ fontSize: 18, color: "var(--text-muted)" }}>🔍</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActiveIdx(0); }}
            onKeyDown={handleKey}
            placeholder="Jump to channel, DM, or action…"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="kc-cmd-list"
            aria-activedescendant={results[clampedIdx] ? `kc-cmd-opt-${results[clampedIdx].id}` : undefined}
            aria-autocomplete="list"
            aria-label="Search channels and DMs"
            style={{
              flex: 1,
              background: "transparent",
              border: "none",
              outline: "none",
              fontSize: 15,
              color: "var(--text-primary)",
            }}
          />
          <kbd
            style={{
              fontSize: 11,
              padding: "2px 6px",
              borderRadius: 4,
              background: "var(--bg-input)",
              color: "var(--text-muted)",
              border: "1px solid var(--bg-hover)",
            }}
          >
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div
          ref={listRef}
          id="kc-cmd-list"
          role="listbox"
          aria-label="Results"
          style={{ maxHeight: 360, overflowY: "auto", padding: "6px" }}
        >
          {results.length === 0 ? (
            <div
              style={{
                padding: "20px 16px",
                textAlign: "center",
                color: "var(--text-muted)",
                fontSize: 13,
              }}
            >
              No channels or actions match "{query}"
            </div>
          ) : (
            results.map((r, i) => (
              // eslint-disable-next-line jsx-a11y/interactive-supports-focus -- combobox owns focus; active option tracked via aria-activedescendant on the input, not roving tabindex
              <div
                key={r.id}
                id={`kc-cmd-opt-${r.id}`}
                role="option"
                aria-selected={i === clampedIdx}
                onMouseEnter={() => setActiveIdx(i)}
                onMouseDown={() => select(r)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "8px 12px",
                  borderRadius: 6,
                  cursor: "pointer",
                  background: i === clampedIdx ? "var(--bg-hover)" : "transparent",
                  transition: "background 0.08s",
                }}
              >
                <span
                  style={{
                    width: 22,
                    height: 22,
                    flexShrink: 0,
                    display: "grid",
                    placeItems: "center",
                    overflow: "hidden",
                    borderRadius: r.serverIconUrl ? 6 : 0,
                    fontSize: 15,
                    color: "var(--text-muted)",
                  }}
                >
                  {r.serverIconUrl ? <img src={r.serverIconUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} /> : r.icon}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 500,
                      color: i === clampedIdx ? "var(--text-primary)" : "var(--text-secondary)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {r.label}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{r.sub}</div>
                </div>
                {i === clampedIdx && (
                  <kbd
                    style={{
                      fontSize: 11,
                      padding: "2px 6px",
                      borderRadius: 4,
                      background: "var(--bg-input)",
                      color: "var(--text-muted)",
                      border: "1px solid var(--bg-hover)",
                    }}
                  >
                    ↵
                  </kbd>
                )}
              </div>
            ))
          )}
        </div>

        {/* Footer hint */}
        <div
          style={{
            borderTop: "1px solid var(--bg-hover)",
            padding: "8px 16px",
            display: "flex",
            gap: 16,
            fontSize: 11,
            color: "var(--text-muted)",
          }}
        >
          <span><kbd style={{ marginRight: 4, padding: "1px 4px", borderRadius: 3, border: "1px solid var(--bg-hover)", background: "var(--bg-input)" }}>↑↓</kbd>navigate</span>
          <span><kbd style={{ marginRight: 4, padding: "1px 4px", borderRadius: 3, border: "1px solid var(--bg-hover)", background: "var(--bg-input)" }}>↵</kbd>open / run</span>
          <span><kbd style={{ marginRight: 4, padding: "1px 4px", borderRadius: 3, border: "1px solid var(--bg-hover)", background: "var(--bg-input)" }}>Esc</kbd>close</span>
        </div>
      </div>
    </div>
  );

  return createPortal(palette, document.body);
}
