// The composer's emoji and GIF picker, opened from the smiley in the message bar.
import type React from "react";
import type { ServerEmoji } from "../api";
import { getFileBase } from "../api";

const EMOJI_CATALOG = [
  ["😀", "grin happy smile"], ["😂", "laugh tears funny"], ["🤣", "rofl laughing"], ["😭", "cry sob"], ["🥹", "teary touched"], ["😍", "love heart eyes"],
  ["🥰", "love hearts"], ["😘", "kiss"], ["😎", "cool sunglasses"], ["🥳", "party celebrate"], ["😤", "huff angry"], ["😡", "rage angry"],
  ["🤯", "mind blown"], ["🫡", "salute"], ["🤔", "think hmm"], ["🫠", "melt"], ["🫶", "heart hands"], ["🙏", "pray please thanks"],
  ["👍", "thumbs up yes"], ["👎", "thumbs down no"], ["👏", "clap applause"], ["🙌", "raise hands"], ["💪", "strong flex"], ["🤝", "handshake"],
  ["❤️", "heart love red"], ["🧡", "orange heart"], ["💛", "yellow heart"], ["💚", "green heart"], ["💙", "blue heart"], ["💜", "purple heart"],
  ["🖤", "black heart"], ["🤍", "white heart"], ["💔", "broken heart"], ["💕", "two hearts"], ["💯", "hundred"], ["✨", "sparkles"],
  ["🔥", "fire hot"], ["⭐", "star"], ["🌙", "moon"], ["☀️", "sun"], ["🌈", "rainbow"], ["⚡", "lightning"],
  ["🎉", "party popper"], ["🎊", "confetti"], ["🎂", "cake birthday"], ["🎁", "gift"], ["🏆", "trophy"], ["🥇", "gold medal"],
  ["👀", "eyes look"], ["💀", "skull dead"], ["🤡", "clown"], ["🤌", "chef kiss"], ["😈", "devil"], ["👻", "ghost"],
  ["🐱", "cat"], ["🐶", "dog"], ["🐸", "frog"], ["🐧", "penguin"], ["🐭", "mouse"], ["🐰", "bunny"],
  ["🍕", "pizza"], ["🍔", "burger"], ["🍟", "fries"], ["🍣", "sushi"], ["🍪", "cookie"], ["☕", "coffee"],
  ["🎮", "game controller"], ["🎧", "headphones music"], ["🎵", "music note"], ["🎬", "movie film"], ["📸", "camera"], ["💻", "laptop code"],
  ["🚀", "rocket launch"], ["🛸", "ufo"], ["🧠", "brain smart"], ["🫵", "you point"], ["✅", "check yes"], ["❌", "x no"],
] as const;

export type GifResult = { id: string; title: string; url: string; preview: string };

export function ComposerMediaPicker({
  tab,
  onTab,
  emojiQuery,
  onEmojiQuery,
  serverEmojis,
  onPickEmoji,
  onPickCustomEmoji,
  gifsAvailable,
  gifQuery,
  onGifQuery,
  gifResults,
  gifLoading,
  gifError,
  gifUrl,
  onGifUrl,
  onSendGif,
}: {
  tab: "emoji" | "gif";
  onTab: (tab: "emoji" | "gif") => void;
  emojiQuery: string;
  onEmojiQuery: (q: string) => void;
  serverEmojis: ServerEmoji[];
  onPickEmoji: (emoji: string) => void;
  onPickCustomEmoji: (emoji: ServerEmoji) => void;
  /** This home can search GIFs (a KLIPY key) and the chat can show them (not encrypted). */
  gifsAvailable: boolean;
  gifQuery: string;
  onGifQuery: (q: string) => void;
  gifResults: GifResult[];
  gifLoading: boolean;
  /** The last search failed. */
  gifError: boolean;
  gifUrl: string;
  onGifUrl: (url: string) => void;
  onSendGif: (url: string) => void;
}) {
  // A home without GIF search has no GIFs tab, so the picker can't be left on it.
  const shown = gifsAvailable ? tab : "emoji";
  const q = emojiQuery.trim().toLowerCase();
  const unicode = EMOJI_CATALOG.filter(([emoji, tags]) => !q || emoji.includes(q) || tags.includes(q)).slice(0, 96);
  const custom = serverEmojis.filter((e) => !q || e.name.toLowerCase().includes(q)).slice(0, 48);
  const pill = (active: boolean): React.CSSProperties => ({
    border: "none",
    borderRadius: 999,
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 800,
    cursor: "pointer",
    background: active ? "var(--accent)" : "var(--bg-input)",
    color: active ? "#fff" : "var(--text-secondary)",
  });

  return (
    <div
      className="mx-4 mb-2 overflow-hidden rounded-2xl border"
      style={{ background: "var(--bg-sidebar)", borderColor: "var(--bg-hover)", boxShadow: "var(--shadow-md)" }}
    >
      <div className="flex items-center justify-between gap-2 border-b p-2" style={{ borderColor: "var(--bg-hover)" }}>
        <div className="flex gap-2">
          <button type="button" onClick={() => onTab("emoji")} style={pill(shown === "emoji")}>Emoji</button>
          {gifsAvailable && (
            <button type="button" onClick={() => onTab("gif")} style={pill(shown === "gif")}>GIFs</button>
          )}
        </div>
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          {shown === "emoji" ? "Unicode + server emoji" : "Powered by KLIPY"}
        </div>
      </div>

      {shown === "emoji" ? (
        <div className="p-3">
          <input
            value={emojiQuery}
            onChange={(e) => onEmojiQuery(e.target.value)}
            placeholder="Search emoji…"
            className="kc-field mb-3 w-full px-3 py-2 text-sm outline-none"
          />
          {custom.length > 0 && (
            <>
              <div className="mb-2 text-[10px] font-bold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Server emoji</div>
              <div className="mb-3 grid grid-cols-8 gap-1 sm:grid-cols-10">
                {custom.map((em) => (
                  <button
                    key={em.id}
                    type="button"
                    onClick={() => onPickCustomEmoji(em)}
                    className="kc-interactive flex h-9 items-center justify-center rounded-lg"
                    style={{ border: "none", background: "var(--bg-input)", cursor: "pointer" }}
                    title={`:${em.name}:`}
                  >
                    <img src={`${getFileBase()}${em.url}`} alt={`:${em.name}:`} className="max-h-7 max-w-7 object-contain" />
                  </button>
                ))}
              </div>
            </>
          )}
          <div className="mb-2 text-[10px] font-bold uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>Emoji</div>
          <div className="grid max-h-56 grid-cols-8 gap-1 overflow-y-auto sm:grid-cols-12">
            {unicode.map(([emoji, tags]) => (
              <button
                key={`${emoji}-${tags}`}
                type="button"
                onClick={() => onPickEmoji(emoji)}
                className="kc-interactive flex h-9 items-center justify-center rounded-lg text-xl"
                style={{ border: "none", background: "transparent", cursor: "pointer" }}
                title={tags}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="p-3">
          <div className="mb-3 flex gap-2">
            <input
              value={gifQuery}
              onChange={(e) => onGifQuery(e.target.value)}
              placeholder="Search KLIPY"
              aria-label="Search GIFs"
              className="kc-field min-w-0 flex-1 px-3 py-2 text-sm outline-none"
            />
          </div>
          <div className="mb-3 flex gap-2">
            <input
              value={gifUrl}
              onChange={(e) => onGifUrl(e.target.value)}
              placeholder="Or paste a GIF/image URL…"
              className="kc-field min-w-0 flex-1 px-3 py-2 text-sm outline-none"
            />
            <button type="button" onClick={() => onSendGif(gifUrl)} className="kc-cta px-3 py-2 text-sm">Send</button>
          </div>
          {gifLoading ? (
            <div className="grid grid-cols-3 gap-2">
              {[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="kc-skeleton h-24 rounded-xl" />)}
            </div>
          ) : gifResults.length > 0 ? (
            <div className="grid max-h-72 grid-cols-2 gap-2 overflow-y-auto sm:grid-cols-3">
              {gifResults.map((gif) => (
                <button
                  key={gif.id}
                  type="button"
                  onClick={() => onSendGif(gif.url)}
                  className="kc-interactive overflow-hidden rounded-xl border p-0"
                  style={{ borderColor: "var(--bg-hover)", background: "var(--bg-input)", cursor: "pointer" }}
                  title={gif.title}
                >
                  <img src={gif.preview} alt={gif.title} className="h-24 w-full object-cover" loading="lazy" />
                </button>
              ))}
            </div>
          ) : (
            <div className="rounded-xl p-4 text-center text-sm" style={{ background: "var(--bg-input)", color: "var(--text-muted)" }}>
              {gifError ? "GIF search isn't answering right now. Try again in a moment." : "No GIFs found. Try another search."}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
