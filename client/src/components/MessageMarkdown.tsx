// What a message says, drawn from its formatting (lib/markdown.ts) with React elements, never
// HTML strings. The row-height estimate (messageContentPx in lib/messageLayout.ts) mirrors the
// sizes these elements get from index.css (.kc-md-*, .code-block); change them together.
import { Fragment, useState, type ReactNode } from "react";
import { getFileBase, type ServerEmoji } from "../api";
import { splitMentions } from "../lib/mentions";
import { formatTimestamp, parseMarkdown, type Block, type Inline, type ListBlock } from "../lib/markdown";

type Ctx = { emoji: Map<string, ServerEmoji>; me: string; now: number };

function SpoilerSpan({ children }: { children: ReactNode }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setRevealed((r) => !r);
      }}
      data-spoiler=""
      aria-pressed={revealed}
      aria-label={revealed ? "Spoiler revealed, activate to hide" : "Spoiler, activate to reveal"}
      style={{
        background: revealed ? "var(--bg-hover)" : "var(--text-secondary)",
        color: revealed ? "var(--text-primary)" : "transparent",
        borderRadius: 3,
        border: "none",
        font: "inherit",
        cursor: "pointer",
        userSelect: "none",
        padding: "0 2px",
        transition: "all 0.2s",
      }}
      title={revealed ? "Click to hide" : "Click to reveal spoiler"}
    >
      {children}
    </button>
  );
}

function CustomEmoji({ emoji }: { emoji: ServerEmoji }) {
  return (
    <img
      src={`${getFileBase()}${emoji.url}`}
      alt={`:${emoji.name}:`}
      title={`:${emoji.name}:`}
      style={{ display: "inline", height: "1.4em", verticalAlign: "middle", borderRadius: 2 }}
    />
  );
}

function mentions(text: string, me: string, key: string): ReactNode[] {
  return splitMentions(text).map((seg, i) => {
    if (!seg.mention) return seg.text;
    const m = seg.mention.toLowerCase();
    // @everyone / @here include you, so give them the stronger "you" highlight too.
    const isMe = m === "everyone" || m === "here" || (!!me && m === me.toLowerCase());
    return (
      <span
        key={`${key}m${i}`}
        style={{
          background: isMe
            ? "color-mix(in oklch, var(--accent) 24%, transparent)"
            : "color-mix(in oklch, var(--accent) 12%, transparent)",
          color: "var(--accent)",
          fontWeight: 600,
          borderRadius: 4,
          padding: "0 3px",
        }}
      >
        {seg.text}
      </span>
    );
  });
}

const stop = (e: React.MouseEvent) => e.stopPropagation();

function renderInline(nodes: readonly Inline[], ctx: Ctx, key: string): ReactNode[] {
  return nodes.map((node, i) => {
    const k = `${key}.${i}`;
    switch (node.kind) {
      case "text":
        return <Fragment key={k}>{mentions(node.text, ctx.me, k)}</Fragment>;
      case "br":
        return <br key={k} />;
      case "bold":
        return <strong key={k}>{renderInline(node.children, ctx, k)}</strong>;
      case "italic":
        return <em key={k}>{renderInline(node.children, ctx, k)}</em>;
      case "underline":
        return <u key={k}>{renderInline(node.children, ctx, k)}</u>;
      case "strike":
        return <s key={k}>{renderInline(node.children, ctx, k)}</s>;
      case "code":
        return (
          <code key={k} className="kc-md-code">
            {node.text}
          </code>
        );
      case "spoiler":
        return <SpoilerSpan key={k}>{renderInline(node.children, ctx, k)}</SpoilerSpan>;
      case "link":
        return (
          <Fragment key={k}>
            <a href={node.href} title={node.href} target="_blank" rel="noopener noreferrer" className="kc-md-link" onClick={stop}>
              {renderInline(node.children, ctx, k)}
            </a>
            {node.destinationHost && <span className="kc-md-link-host"> ({node.destinationHost})</span>}
          </Fragment>
        );
      case "url":
        return (
          <a key={k} href={node.href} target="_blank" rel="noopener noreferrer" className="kc-md-link" onClick={stop}>
            {node.text}
          </a>
        );
      case "emoji": {
        const emoji = ctx.emoji.get(node.name);
        return emoji ? <CustomEmoji key={k} emoji={emoji} /> : <Fragment key={k}>{`:${node.name}:`}</Fragment>;
      }
      case "time": {
        const at = new Date(node.unix * 1000);
        return (
          <time key={k} className="kc-md-time" dateTime={at.toISOString()} title={formatTimestamp(node.unix, "F", { now: ctx.now })}>
            {formatTimestamp(node.unix, node.style, { now: ctx.now })}
          </time>
        );
      }
    }
  });
}

function renderList(list: ListBlock, ctx: Ctx, key: string): ReactNode {
  const items = list.items.map((item, i) => (
    <li key={`${key}.${i}`}>
      {renderInline(item.children, ctx, `${key}.${i}`)}
      {item.sublist && renderList(item.sublist, ctx, `${key}.${i}s`)}
    </li>
  ));
  return list.ordered ? (
    <ol key={key} className="kc-md-list" start={list.start === 1 ? undefined : list.start}>
      {items}
    </ol>
  ) : (
    <ul key={key} className="kc-md-list">
      {items}
    </ul>
  );
}

function renderBlocks(blocks: readonly Block[], ctx: Ctx, key: string): ReactNode[] {
  return blocks.map((block, i) => {
    const k = `${key}${i}`;
    switch (block.kind) {
      case "paragraph":
        return <Fragment key={k}>{renderInline(block.children, ctx, k)}</Fragment>;
      case "heading": {
        const Tag = (["h1", "h2", "h3"] as const)[block.level - 1];
        return (
          <Tag key={k} className={`kc-md-heading kc-md-h${block.level}`}>
            {renderInline(block.children, ctx, k)}
          </Tag>
        );
      }
      case "subtext":
        return (
          <small key={k} className="kc-md-subtext">
            {renderInline(block.children, ctx, k)}
          </small>
        );
      case "quote":
        return (
          <blockquote key={k} className="kc-md-quote">
            {renderBlocks(block.children, ctx, `${k}q`)}
          </blockquote>
        );
      case "list":
        return renderList(block, ctx, k);
      case "code":
        return (
          <pre
            key={k}
            className="code-block"
            data-lang={block.lang ?? undefined}
            style={{
              display: "block",
              background: "#1e1e2e",
              color: "#cdd6f4",
              borderRadius: 6,
              padding: "10px 14px",
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              fontSize: 13,
              overflowX: "auto",
              margin: "6px 0",
              borderLeft: "3px solid var(--accent)",
            }}
          >
            <code>{block.text}</code>
          </pre>
        );
    }
  });
}

export function MessageContent({
  content,
  serverEmojis,
  currentUsername = "",
  now,
}: {
  content: string;
  serverEmojis: ServerEmoji[];
  currentUsername?: string;
  /** The clock relative timestamps count from (tests pin it). */
  now?: number;
}) {
  // Forwarded message: 【FWD:author】<original content>
  const fwd = content.match(/^【FWD:([^】]*)】([\s\S]*)$/);
  if (fwd) {
    const [, author, rest] = fwd;
    return (
      <>
        <span className="flex items-center gap-1" style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>
          <span style={{ color: "var(--accent)" }}>↪</span> Forwarded from <strong style={{ color: "var(--text-secondary)" }}>{author}</strong>
        </span>
        {rest && <MessageContent content={rest} serverEmojis={serverEmojis} currentUsername={currentUsername} now={now} />}
      </>
    );
  }
  // Big emoji shortcut
  if (content.startsWith("【BIG_EMOJI:") && content.endsWith("】")) {
    const emoji = content.slice(12, -1);
    return <span className="big-emoji-char" style={{ fontSize: "2.5rem", lineHeight: 1.2 }}>{emoji}</span>;
  }
  const ctx: Ctx = { emoji: new Map(serverEmojis.map((e) => [e.name, e])), me: currentUsername, now: now ?? Date.now() };
  return <>{renderBlocks(parseMarkdown(content), ctx, "b")}</>;
}
