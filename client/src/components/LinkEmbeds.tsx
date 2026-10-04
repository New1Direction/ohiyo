// Links that play in the chat: a YouTube video or a post on X. A card never loads the
// player by itself. It shows a button, and the frame from YouTube or X is only put on the
// page when the reader presses it, so reading a chat does not tell those sites who is
// reading. Sizes here are mirrored by embedRowPx (lib/linkEmbeds.ts), which the
// virtualized list uses to give each row its height.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import {
  X_FRAME_START_PX,
  type LinkEmbed,
  xFrameHeight,
  xPostFrameUrl,
  youtubePlayerUrl,
  youtubeThumbnailUrl,
} from "../lib/linkEmbeds";

/** Which cards are open, by embedKey. For a post on X the value is its frame's height. */
export type EmbedOpenState = {
  heights: ReadonlyMap<string, number>;
  /** Open a card (or resize an open one); `undefined` closes it. */
  set: (key: string, height: number | undefined) => void;
};

// Held by the chat, not by the card: a row that scrolls out of the list is unmounted, and
// the list has to know a card's height before it renders the row.
export const EmbedOpenContext = createContext<EmbedOpenState | null>(null);

function useEmbedOpen(key: string): [number | undefined, (height: number | undefined) => void] {
  const shared = useContext(EmbedOpenContext);
  const [local, setLocal] = useState<number | undefined>(undefined);
  if (shared) return [shared.heights.get(key), (height) => shared.set(key, height)];
  return [local, setLocal];
}

type Props = {
  url: string;
  embed: LinkEmbed;
  /** embedKey(messageId, url). */
  openKey: string;
  /** Show the video's picture and title before the click. Off in encrypted chats. */
  showPreview: boolean;
  title?: string | null;
};

const FRAME_ALLOW = "autoplay; encrypted-media; picture-in-picture; fullscreen";

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden focusable="false">
      <path d="M8.5 5.6v12.8a.8.8 0 0 0 1.2.7l10.6-6.4a.8.8 0 0 0 0-1.4L9.7 4.9a.8.8 0 0 0-1.2.7z" fill="currentColor" />
    </svg>
  );
}

function Caption({ site, url, label, onClose }: { site: string; url: string; label: string; onClose?: () => void }) {
  return (
    <div className="kc-embed__caption">
      <span className="kc-embed__site">{site}</span>
      <a href={url} target="_blank" rel="noopener noreferrer" className="kc-embed__title" onClick={(e) => e.stopPropagation()}>
        {label}
      </a>
      {onClose && (
        <button type="button" className="kc-embed__close" onClick={onClose}>
          Close
        </button>
      )}
    </div>
  );
}

function Chip({ title, note, label, onOpen }: { title: string; note: string; label: string; onOpen: () => void }) {
  return (
    <div className="kc-embed kc-embed--chip">
      <button type="button" className="kc-embed__chip" aria-label={label} onClick={onOpen}>
        <span className="kc-embed__play kc-embed__play--small">
          <PlayIcon />
        </span>
        <span className="kc-embed__chip-text">
          <span className="kc-embed__chip-title">{title}</span>
          <span className="kc-embed__chip-note">{note}</span>
        </span>
      </button>
    </div>
  );
}

function YouTubeEmbed({ url, embed, openKey, showPreview, title }: Props & { embed: Extract<LinkEmbed, { kind: "youtube" }> }) {
  const [openHeight, setOpen] = useEmbedOpen(openKey);
  // True only for a player the reader has just pressed play on. One that is coming back
  // into view (the list unmounts rows that scroll away) loads paused.
  const [playNow, setPlayNow] = useState(false);
  const name = title?.trim() || "YouTube video";
  const play = () => {
    setPlayNow(true);
    setOpen(1);
  };

  if (openHeight === undefined && !showPreview) {
    return <Chip title="Play video here" note="Loads from YouTube when you press play" label="Play this YouTube video here" onOpen={play} />;
  }

  return (
    <div className="kc-embed kc-embed--video">
      <div className="kc-embed__stage">
        {openHeight === undefined ? (
          <button type="button" className="kc-embed__poster" aria-label={`Play ${name} here`} onClick={play}>
            <img
              src={youtubeThumbnailUrl(embed.id)}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={(e) => {
                (e.target as HTMLImageElement).style.visibility = "hidden";
              }}
            />
            <span className="kc-embed__play">
              <PlayIcon />
            </span>
          </button>
        ) : (
          <iframe
            src={youtubePlayerUrl(embed.id, embed.start, playNow)}
            title={name}
            allow={FRAME_ALLOW}
            allowFullScreen
            referrerPolicy="strict-origin-when-cross-origin"
          />
        )}
      </div>
      <Caption site="YouTube" url={url} label={name} onClose={openHeight === undefined ? undefined : () => setOpen(undefined)} />
    </div>
  );
}

function XPostEmbed({ url, embed, openKey }: Props & { embed: Extract<LinkEmbed, { kind: "x" }> }) {
  const [openHeight, setOpen] = useEmbedOpen(openKey);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const isOpen = openHeight !== undefined;
  const by = embed.handle ? `Post by @${embed.handle}` : "Post on X";

  // setOpen is rebuilt every render; the listener below reads the latest one from here.
  const setOpenRef = useRef(setOpen);
  useEffect(() => {
    setOpenRef.current = setOpen;
  });

  // X's frame tells the page how tall the post is once it has drawn it.
  useEffect(() => {
    if (!isOpen) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const height = xFrameHeight(event.origin, event.data, embed.id);
      if (height !== null) setOpenRef.current(height);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [isOpen, embed.id]);

  if (!isOpen) {
    return <Chip title="Show this post here" note={`${by} · loads from X when you press it`} label={`Show this post from X here. ${by}`} onOpen={() => setOpen(X_FRAME_START_PX)} />;
  }

  return (
    <div className="kc-embed kc-embed--post">
      <iframe
        ref={frameRef}
        src={xPostFrameUrl(embed.id)}
        title={by}
        allow={FRAME_ALLOW}
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        // X's frame needs scripts and its own storage; it gets no way to move this page.
        sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"
        style={{ height: openHeight }}
      />
      <Caption site="X" url={url} label="Open on X" onClose={() => setOpen(undefined)} />
    </div>
  );
}

/** The card for a link that can play in the chat. */
export function PlayableEmbed(props: Props) {
  return props.embed.kind === "youtube" ? <YouTubeEmbed {...props} embed={props.embed} /> : <XPostEmbed {...props} embed={props.embed} />;
}
