import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Channel, ServerWithChannels } from "../api";

type Result = {
  id: string;
  label: string;
  sub: string;
  icon: string;
  channel: Channel;
};

type Props = {
  servers: ServerWithChannels[];
  dms: Channel[];
  onSelectChannel: (channel: Channel) => void;
  onClose: () => void;
};

export function CommandPalette({ servers, dms, onSelectChannel, onClose }: Props) {
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
      channel: ch,
    })),
    ...servers.flatMap((s) =>
      s.channels.map((ch) => ({
        id: ch.id,
        label: ch.name,
        sub: s.name,
        icon: ch.channel_type === "voice" ? "🔊" : "#",
        channel: ch,
      }))
    ),
  ];

  const q = query.toLowerCase().trim();
  const results = q
    ? allChannels.filter(
        (r) =>
          r.label.toLowerCase().includes(q) ||
          r.sub.toLowerCase().includes(q)
      )
    : allChannels.slice(0, 10);

  const clampedIdx = Math.min(activeIdx, Math.max(0, results.length - 1));

  function select(r: Result) {
    onSelectChannel(r.channel);
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
            placeholder="Jump to channel or DM…"
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
              No channels match "{query}"
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
                <span style={{ fontSize: 15, minWidth: 20, textAlign: "center", color: "var(--text-muted)" }}>
                  {r.icon}
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
          <span><kbd style={{ marginRight: 4, padding: "1px 4px", borderRadius: 3, border: "1px solid var(--bg-hover)", background: "var(--bg-input)" }}>↵</kbd>jump</span>
          <span><kbd style={{ marginRight: 4, padding: "1px 4px", borderRadius: 3, border: "1px solid var(--bg-hover)", background: "var(--bg-input)" }}>Esc</kbd>close</span>
        </div>
      </div>
    </div>
  );

  return createPortal(palette, document.body);
}
