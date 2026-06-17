import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDropzone } from "react-dropzone";
import { VariableSizeList as List } from "react-window";
import type { AttachmentMeta, Embed, Message, Channel, ReactionGroup, ServerEmoji, PublicUser } from "../api";
import type { WatchSession } from "../gateway";
import type { TrustState } from "../lib/identityTrust";
import { WatchParty } from "./WatchParty";
import { api, getApiBase, getFileBase } from "../api";
import type { PluginManager } from "../plugins/registry";
import { UserProfileCard } from "./UserProfileCard";
import { GroupMembersPopover } from "./GroupMembersPopover";
import { BirdMark } from "./BirdMark";
import { ChannelWelcome } from "./ChannelWelcome";
import { PollWidget } from "./PollWidget";
import { PollComposer } from "./PollComposer";
import { activeMentionQuery, applyMention, splitMentions } from "../lib/mentions";
import { DISAPPEAR_OPTIONS, formatDuration, timeLeft } from "../lib/disappearing";
import { APPEARANCE_CHANGED_EVENT } from "../lib/appearance";
import { Icon } from "./Icon";
import { MessageActionSheet } from "./MessageActionSheet";

// Composer drafts persisted per channel so a half-written message survives a reload,
// not just a channel switch. Cleared on send.
const DRAFT_PREFIX = "kc:draft:";
function persistDraft(channelId: string, text: string) {
  try {
    if (text.trim()) localStorage.setItem(DRAFT_PREFIX + channelId, text);
    else localStorage.removeItem(DRAFT_PREFIX + channelId);
  } catch {
    /* storage off */
  }
}
function loadDraft(channelId: string): string {
  try {
    return localStorage.getItem(DRAFT_PREFIX + channelId) ?? "";
  } catch {
    return "";
  }
}

// Reading position persisted per channel, so leaving a channel mid-history and coming
// back lands you where you were — not yanked to the bottom. Stored only when scrolled
// up; cleared (→ open at bottom) when the user was already at the latest message.
const SCROLL_PREFIX = "kc:scroll:";
function persistScroll(channelId: string, offset: number | null) {
  try {
    if (offset != null && offset > 0) localStorage.setItem(SCROLL_PREFIX + channelId, String(Math.round(offset)));
    else localStorage.removeItem(SCROLL_PREFIX + channelId);
  } catch {
    /* storage off */
  }
}
function loadScroll(channelId: string): number | null {
  try {
    const v = localStorage.getItem(SCROLL_PREFIX + channelId);
    return v == null ? null : Number(v) || null;
  } catch {
    return null;
  }
}

// ── Link preview types ────────────────────────────────────────────────────────
type OgData = {
  url: string;
  title: string | null;
  description: string | null;
  image: string | null;
  site_name: string | null;
  favicon: string | null;
};

const QUICK_EMOJI = ["👍", "❤️", "😂", "😮", "😢", "🔥", "✅", "🎉", "👀", "🚀", "💯", "🙏", "😍", "😎", "🤔"];

type Props = {
  channel: Channel | null;
  messages: Message[];
  currentUserId: string;
  token: string;
  pluginManager: PluginManager;
  serverEmojis: ServerEmoji[];
  onSend: (content: string, attachmentIds?: string[], replyTo?: string | null) => void;
  onRetry?: (msg: Message) => void;
  onDiscardFailed?: (id: string) => void;
  onToast: (text: string, type?: "info" | "success" | "error") => void;
  isLoading: boolean;
  /** Opens the mobile nav drawer (no-op affordance on desktop, hidden via CSS). */
  onOpenNav?: () => void;
  /** People currently typing in this channel (excludes self). */
  typingUsers?: PublicUser[];
  /** Called (throttled by the composer) while the user types. */
  onTyping?: () => void;
  onEditMessage?: (messageId: string, content: string) => void;
  onDeleteMessage?: (messageId: string) => void;
  onPinMessage?: (messageId: string, pinned: boolean) => void;
  onForward?: (msg: Message) => void;
  onSaveRecovery?: () => void;
  onOpenSearch?: () => void;
  onOpenMembers?: () => void;
  /** Members offered in the @-mention autocomplete (current server). */
  mentionables?: PublicUser[];
  /** Current user's username, for highlighting mentions of you. */
  currentUsername?: string;
  /** Read cursors for this channel (userId → last_read_at). Drives DM receipts. */
  receipts?: Record<string, number>;
  /** Active watch-party session for this channel (synced video), or null. */
  watchSession?: WatchSession | null;
  onWatchControl?: (action: string, payload?: { url?: string; position?: number }) => void;
  /** Whether this DM is in end-to-end encrypted mode, and the toggle (DMs only). */
  e2eEnabled?: boolean;
  /** Live participant list for a group DM (drives the members popover). */
  groupMembers?: PublicUser[];
  onToggleE2e?: () => void;
  /** Lazily compute the Signal safety number for the peer (null if no session yet). */
  onRequestSafetyNumber?: () => Promise<string | null>;
  /** Identity-verification trust state for this DM peer — drives the key-change warning. */
  e2eTrust?: TrustState;
  /** Mark the peer verified (their safety number matched out-of-band). */
  onMarkVerified?: () => void;
  /** Dismiss a pending "safety number changed" warning for this peer. */
  onDismissKeyChange?: () => void;
  /** Set this channel's disappearing-message TTL in seconds (null turns it off). */
  onSetDisappearing?: (seconds: number | null) => void;
};

/** Delivered / Seen line under your latest sent message — DMs only (iMessage-style). */
function ReceiptLine({
  channel,
  messages,
  currentUserId,
  receipts,
}: {
  channel: Channel | null;
  messages: Message[];
  currentUserId: string;
  receipts?: Record<string, number>;
}) {
  const isDm = channel?.channel_type === "dm" || channel?.channel_type === "group_dm";
  if (!isDm || messages.length === 0) return null;
  const last = messages[messages.length - 1];
  // Only render under your own most-recent message, and only once it's really sent.
  if (
    last.author?.id !== currentUserId ||
    last.id.startsWith("temp-") ||
    last._state === "pending" ||
    last._state === "failed"
  ) {
    return null;
  }
  const seen = receipts
    ? Object.entries(receipts).some(([uid, at]) => uid !== currentUserId && at >= last.created_at)
    : false;
  return (
    <div className="kc-receipt" aria-live="polite">
      {seen ? "Seen" : "Delivered"}
    </div>
  );
}

function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2.4" strokeLinecap="round" aria-hidden>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </svg>
  );
}

type UploadedFile = {
  id: string;
  filename: string;
  url: string;
  content_type: string;
  size_bytes: number;
};

export function ChatPane({
  channel,
  messages,
  currentUserId,
  token,
  pluginManager,
  serverEmojis,
  onSend,
  onRetry,
  onDiscardFailed,
  onToast,
  isLoading,
  onOpenNav,
  typingUsers = [],
  onTyping,
  onEditMessage,
  onDeleteMessage,
  onPinMessage,
  onForward,
  onSaveRecovery,
  onOpenSearch,
  onOpenMembers,
  mentionables = [],
  currentUsername = "",
  receipts,
  watchSession,
  onWatchControl,
  e2eEnabled = false,
  groupMembers,
  onToggleE2e,
  onRequestSafetyNumber,
  e2eTrust = "unverified",
  onMarkVerified,
  onDismissKeyChange,
  onSetDisappearing,
}: Props) {
  // Initialize from the persisted draft so a reload (which mounts straight into the
  // restored channel, with prevChannelRef already equal) still shows it.
  const [input, setInput] = useState(() => (channel?.id ? loadDraft(channel.id) : ""));
  const [watchInput, setWatchInput] = useState<string | null>(null);
  const [showGroupMembers, setShowGroupMembers] = useState(false);
  // Composer is sacred: remember unsent text per channel so a switch never loses it.
  const draftsRef = useRef<Record<string, string>>({});
  const inputRef = useRef(input);
  inputRef.current = input;
  ogAuthToken = token; // keep the link-preview fetch authenticated
  const prevChannelRef = useRef<string | null>(channel?.id ?? null);
  const [mention, setMention] = useState<{ query: string; at: number } | null>(null);
  const [replyTarget, setReplyTarget] = useState<Message | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [showPoll, setShowPoll] = useState(false);
  const lastTypingRef = useRef(0);
  const [pendingFiles, setPendingFiles] = useState<UploadedFile[]>([]);
  const [_uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  const [emojiPickerFor, setEmojiPickerFor] = useState<string | null>(null);
  const [pickerPos, setPickerPos] = useState<{ x: number; y: number } | null>(null);
  const [profileUserId, setProfileUserId] = useState<string | null>(null);
  // Signal safety number: revealed only on demand (optional verification).
  const [safety, setSafety] = useState<{ open: boolean; value: string | null; loading: boolean }>({
    open: false,
    value: null,
    loading: false,
  });
  // Open + compute the safety number (shared by the banner's Verify button and the
  // key-change warning's "Verify now").
  const openSafetyNumber = useCallback(async () => {
    if (!onRequestSafetyNumber) return;
    setSafety({ open: true, value: null, loading: true });
    try {
      const value = await onRequestSafetyNumber();
      setSafety({ open: true, value, loading: false });
    } catch (err) {
      console.error("safety number failed", err);
      setSafety({ open: true, value: null, loading: false });
    }
  }, [onRequestSafetyNumber]);
  // Disappearing-message duration picker (open on demand from the header clock).
  const [disappearOpen, setDisappearOpen] = useState(false);
  // Touch: the message a ⋯ tap opened the action sheet for (hover toolbar is unreachable on touch).
  const [actionSheetMsg, setActionSheetMsg] = useState<Message | null>(null);
  const profileAnchorRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<List>(null);
  const listOuterRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLInputElement>(null);
  // Row-height metrics read from the density/font-scale CSS vars. Cached in a ref and
  // refreshed only on the appearance-changed event (not per render) so estimateHeight
  // stays cheap. estimateHeight reads metricsRef.current; the listener re-measures.
  const metricsRef = useRef({ linePx: 20, basePx: 44, fontScale: 1 });
  // Scroll anchoring: only follow new messages when the user is already at the
  // bottom (or we explicitly want it). forceBottomRef wins for own-send / switch.
  const atBottomRef = useRef(true);
  const forceBottomRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  // Per-channel reading position. scrollMapRef is the live (in-session) map; a switch
  // (or reload) persists it. pendingRestoreRef carries an offset to re-apply after the
  // incoming channel's rows have rendered.
  const scrollMapRef = useRef<Record<string, { offset: number; atBottom: boolean }>>({});
  const pendingRestoreRef = useRef<number | null>(null);

  // Members matching the open @-mention query (max 6).
  const mentionMatches = mention
    ? mentionables
        .filter((m) => {
          const q = mention.query.toLowerCase();
          return m.username.toLowerCase().startsWith(q) || m.display_name.toLowerCase().includes(q);
        })
        .slice(0, 6)
    : [];

  function onComposerChange(value: string, caret: number) {
    setInput(value);
    setMention(activeMentionQuery(value, caret));
    notifyTyping();
    // Persist immediately so a reload never loses it (beforeunload is just a backstop).
    if (channel?.id) persistDraft(channel.id, value);
  }

  function pickMention(username: string) {
    if (!mention) return;
    const caret = composerRef.current?.selectionStart ?? input.length;
    const next = applyMention(input, mention.at, caret, username);
    setInput(next.value);
    setMention(null);
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
      }
    });
  }

  // Refresh the row-height metrics from the density/font-scale CSS vars on mount and
  // whenever the user changes density or font scale, then drop react-window's cached
  // heights so every row re-measures at the new scale.
  useEffect(() => {
    const readMetrics = () => {
      const cs = getComputedStyle(document.documentElement);
      const fontScale = Number.parseFloat(cs.getPropertyValue("--msg-font-scale")) || 1;
      const linePx = (Number.parseFloat(cs.getPropertyValue("--msg-line-px")) || 20) * fontScale;
      const basePx = Number.parseFloat(cs.getPropertyValue("--msg-base-px")) || 44;
      metricsRef.current = { linePx, basePx, fontScale };
    };
    readMetrics();
    // The ref initializes to the cozy defaults; if the saved density/scale differs,
    // re-measure now so the first paint isn't sized for the wrong density.
    listRef.current?.resetAfterIndex(0);
    const onChange = () => {
      readMetrics();
      listRef.current?.resetAfterIndex(0);
    };
    window.addEventListener(APPEARANCE_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(APPEARANCE_CHANGED_EVENT, onChange);
  }, []);

  // Re-measure rows, then auto-scroll to the latest ONLY if the user is at the
  // bottom (or we forced it). If they're reading history, surface a jump pill
  // instead of yanking them down — "scroll never betrays the user".
  useEffect(() => {
    listRef.current?.resetAfterIndex(0);
    const last = groups.length - 1;
    if (last < 0) return;
    // A channel switch may have stashed a reading position to restore once the new
    // channel's rows exist. Consume it before the auto-scroll-to-bottom logic.
    const restore = pendingRestoreRef.current;
    if (restore != null) {
      pendingRestoreRef.current = null;
      listRef.current?.scrollTo(restore);
      atBottomRef.current = false;
      setShowJump(true); // they're reading history → offer the jump pill
      return;
    }
    if (forceBottomRef.current || atBottomRef.current) {
      listRef.current?.scrollToItem(last, "end");
      forceBottomRef.current = false;
      setShowJump(false);
    } else {
      setShowJump(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- groups is derived from messages (declared below); re-running on messages already covers groups.length
  }, [messages]);

  // Track whether the user is pinned to the bottom (read off the scroll container) and
  // remember this channel's reading position for restore-on-return.
  function handleListScroll() {
    const el = listOuterRef.current;
    if (!el) return;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 140;
    if (atBottomRef.current) setShowJump(false);
    if (channel?.id) scrollMapRef.current[channel.id] = { offset: el.scrollTop, atBottom: atBottomRef.current };
  }

  function jumpToBottom() {
    const last = groups.length - 1;
    if (last >= 0) listRef.current?.scrollToItem(last, "end");
    atBottomRef.current = true;
    setShowJump(false);
  }

  // Reset the typing-ping throttle when switching channels so the first
  // keystroke in a new channel always fires.
  useEffect(() => {
    lastTypingRef.current = 0;
  }, [channel?.id]);

  // Per-channel drafts: on switch, stash the outgoing draft and restore the
  // incoming one; don't carry a half-written reply/mention across channels.
  useEffect(() => {
    const prev = prevChannelRef.current;
    const next = channel?.id ?? null;
    if (prev === next) return;
    if (prev) {
      draftsRef.current[prev] = inputRef.current;
      persistDraft(prev, inputRef.current); // survive a reload, not just a switch
      // Stash where the user was reading in the channel they're leaving.
      const s = scrollMapRef.current[prev];
      persistScroll(prev, s && !s.atBottom ? s.offset : null);
    }
    let restored = next ? draftsRef.current[next] ?? "" : "";
    if (next && !restored) restored = loadDraft(next);
    setInput(restored);
    setReplyTarget(null);
    setMention(null);
    setSafety({ open: false, value: null, loading: false }); // safety number is per-peer
    setDisappearOpen(false);
    prevChannelRef.current = next;

    // Restore the incoming channel's reading position (in-memory first, then storage);
    // open at the bottom when there's nothing saved or they were already at the latest.
    const mem = next ? scrollMapRef.current[next] : undefined;
    const saved = mem ? (mem.atBottom ? null : mem.offset) : next ? loadScroll(next) : null;
    if (saved != null && saved > 0) {
      pendingRestoreRef.current = saved;
      atBottomRef.current = false;
      forceBottomRef.current = false;
    } else {
      pendingRestoreRef.current = null;
      atBottomRef.current = true;
      forceBottomRef.current = true; // a freshly-opened channel starts at the bottom
    }
    setShowJump(false);
  }, [channel?.id]);

  // Persist the CURRENT channel's draft on reload/close (the switch effect only fires
  // on a change, so a straight reload would otherwise drop it).
  useEffect(() => {
    const save = () => {
      if (!channel?.id) return;
      persistDraft(channel.id, inputRef.current);
      const s = scrollMapRef.current[channel.id];
      persistScroll(channel.id, s && !s.atBottom ? s.offset : null);
    };
    window.addEventListener("beforeunload", save);
    return () => {
      save();
      window.removeEventListener("beforeunload", save);
    };
  }, [channel?.id]);

  // Close emoji picker on outside click.
  useEffect(() => {
    if (!emojiPickerFor) return;
    const close = () => setEmojiPickerFor(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [emojiPickerFor]);

  // Apply plugin message transforms.
  const displayMessages = messages
    .map((m) => pluginManager.applyMessageTransforms(m))
    .filter((m): m is Message => m !== null);

  // Group consecutive messages by same author.
  type MsgGroup = { author: Message["author"]; msgs: Message[]; isMe: boolean };
  const groups: MsgGroup[] = [];
  for (const msg of displayMessages) {
    const last = groups[groups.length - 1];
    if (last && last.author.id === msg.author.id) {
      last.msgs.push(msg);
    } else {
      groups.push({ author: msg.author, msgs: [msg], isMe: msg.author.id === currentUserId });
    }
  }

  function estimateHeight(index: number): number {
    const g = groups[index];
    if (!g) return 60;
    const { linePx, basePx, fontScale } = metricsRef.current;
    // Fewer characters fit per line as the font scales up, so the wrap estimate tracks it.
    const charsPerLine = Math.max(20, Math.round(80 / fontScale));
    const textLines = g.msgs.reduce((sum, m) => sum + Math.ceil(m.content.length / charsPerLine), 0);
    // Reserve the real rendered image height so loading an image never shifts layout.
    const imageH = g.msgs.reduce(
      (sum, m) =>
        sum +
        (m.attachments ?? []).reduce((s, a) => {
          if (!a.content_type.startsWith("image/")) return s;
          return s + (a.width && a.height ? fitImg(a.width, a.height, 400, 300).h + 20 : 160);
        }, 0),
      0
    );
    const hasReactions = g.msgs.some((m) => (m.reactions?.length ?? 0) > 0);
    const replies = g.msgs.filter((m) => m.reply_to).length;
    const pins = g.msgs.filter((m) => m.pinned).length;
    const failed = g.msgs.filter((m) => m._state === "failed").length;
    const pollH = g.msgs.reduce((sum, m) => sum + (m.poll ? 70 + m.poll.options.length * 38 : 0), 0);
    const embedsH = g.msgs.reduce((sum, m) => sum + (m.embeds?.length ?? 0) * 92, 0);
    return basePx + Math.max(textLines, 1) * linePx + imageH + (hasReactions ? 32 : 0) + replies * 22 + pins * 20 + failed * 26 + pollH + embedsH;
  }

  const handleSend = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const transformed = pluginManager.applyTransformSend(input.trim());
      if (!transformed && pendingFiles.length === 0) return;
      if (!channel) return;
      forceBottomRef.current = true; // always follow your own message to the bottom
      onSend(transformed, pendingFiles.map((f) => f.id), replyTarget?.id ?? null);
      setInput("");
      draftsRef.current[channel.id] = "";
      persistDraft(channel.id, ""); // sent → no lingering draft
      setPendingFiles([]);
      setReplyTarget(null);
    },
    [input, pendingFiles, channel, pluginManager, onSend, replyTarget]
  );

  // Throttle "typing…" pings so we emit at most one every few seconds.
  function notifyTyping() {
    const now = Date.now();
    if (onTyping && now - lastTypingRef.current > 2500) {
      lastTypingRef.current = now;
      onTyping();
    }
  }

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (!token) return;
      setUploading(true);

      const results: UploadedFile[] = [];
      for (const file of acceptedFiles) {
        const formData = new FormData();
        formData.append("file", file);

        try {
          const xhr = new XMLHttpRequest();
          const progressKey = file.name;

          await new Promise<void>((resolve, reject) => {
            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) {
                setUploadProgress((prev) => ({
                  ...prev,
                  [progressKey]: Math.round((e.loaded / e.total) * 100),
                }));
              }
            };
            xhr.onload = () => {
              if (xhr.status < 300) {
                const data = JSON.parse(xhr.responseText) as UploadedFile[];
                results.push(...data);
                resolve();
              } else {
                reject(new Error(`Upload failed: ${xhr.status}`));
              }
            };
            xhr.onerror = () => reject(new Error("Network error"));

            xhr.open("POST", `${getApiBase()}/upload`);
            xhr.setRequestHeader("Authorization", `Bearer ${token}`);
            xhr.send(formData);
          });

          setUploadProgress((prev) => {
            const next = { ...prev };
            delete next[progressKey];
            return next;
          });
        } catch {
          onToast(`Upload failed: ${file.name}`, "error");
        }
      }

      setPendingFiles((prev) => [...prev, ...results]);
      setUploading(false);
    },
    [token, onToast]
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    onDrop,
    noClick: true,
    noKeyboard: true,
  });

  async function handleReact(msg: Message, emoji: string) {
    if (!channel) return;
    try {
      await api.react(token, channel.id, msg.id, emoji);
    } catch {
      onToast("Reaction failed", "error");
    }
  }

  async function handleVotePoll(messageId: string, optionId: string) {
    if (!channel) return;
    try {
      await api.votePoll(token, channel.id, messageId, optionId);
    } catch {
      onToast("Couldn't register your vote", "error");
    }
  }

  async function handleSave(messageId: string) {
    if (!channel) return;
    try {
      await api.saveMessage(token, channel.id, messageId);
      onToast("Saved 🔖", "success");
    } catch {
      onToast("Couldn't save that", "error");
    }
  }

  if (!channel) {
    return (
      <div
        className="relative flex flex-1 flex-col items-center justify-center text-center"
        style={{ color: "var(--text-muted)", background: "var(--bg-channel)", padding: "var(--space-6)" }}
      >
        {onOpenNav && (
          <button
            type="button"
            onClick={onOpenNav}
            aria-label="Open channels"
            className="kc-nav-toggle kc-interactive absolute left-3 top-3 items-center justify-center p-2"
            style={{ color: "var(--text-secondary)", background: "var(--bg-input)", borderRadius: "var(--radius-md)" }}
          >
            <MenuIcon />
          </button>
        )}
        <div style={{ color: "var(--accent)", marginBottom: "var(--space-4)", opacity: 0.9 }}>
          <BirdMark size={96} />
        </div>
        <div
          style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: "var(--text-2xl)", color: "var(--text-primary)", marginBottom: "var(--space-2)" }}
        >
          Pick a channel to start chatting
        </div>
        <div className="text-sm" style={{ maxWidth: 360 }}>
          Your conversations live on the left. Choose one and say hi.
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col" style={{ background: "var(--bg-channel)" }} {...getRootProps()}>
      <input {...getInputProps()} />

      {/* Drop overlay */}
      {isDragActive && (
        <div
          className="absolute inset-0 z-40 flex flex-col items-center justify-center"
          style={{
            background: "color-mix(in oklch, var(--accent) 14%, transparent)",
            border: "2px dashed var(--accent)",
            borderRadius: "var(--radius-lg)",
          }}
        >
          <div className="text-4xl mb-2">📁</div>
          <div className="font-semibold" style={{ color: "var(--accent)" }}>
            Drop it anywhere — files of any size are welcome
          </div>
        </div>
      )}

      {/* Channel header */}
      <div
        className="flex h-12 flex-shrink-0 items-center gap-2 px-4 font-semibold shadow-sm"
        style={{ borderBottom: "1px solid var(--bg-base)", fontSize: 15 }}
      >
        {onOpenNav && (
          <button
            type="button"
            onClick={onOpenNav}
            aria-label="Open channels"
            className="kc-nav-toggle kc-interactive -ml-1 items-center justify-center p-1"
            style={{ color: "var(--text-secondary)" }}
          >
            <MenuIcon />
          </button>
        )}
        <span style={{ color: "var(--text-muted)" }}>
          {channel.channel_type === "dm" ? "👤" : "#"}
        </span>
        <span>{channel.name !== "dm" ? channel.name : "Direct Message"}</span>
        {channel.imported && (
          <span
            className="rounded-full px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide"
            style={{ background: "color-mix(in oklch, var(--gold, #f59e0b) 16%, transparent)", color: "var(--gold, #f59e0b)" }}
            title="Imported from Discord — not end-to-end encrypted"
          >
            Imported · not E2E
          </span>
        )}
        {channel.topic && (
          <>
            <span className="kc-ch-topic" style={{ color: "var(--bg-hover)" }}>│</span>
            <span className="kc-ch-topic truncate text-sm font-normal" style={{ color: "var(--text-muted)" }}>
              {channel.topic}
            </span>
          </>
        )}
        <div className="flex-1" />
        {onOpenSearch && (
          <button
            type="button"
            onClick={onOpenSearch}
            aria-label="Open search"
            title="Search"
            className="kc-icon-btn flex-shrink-0 text-base"
          >
            <Icon name="search" />
          </button>
        )}
        {onOpenMembers && (
          <button
            type="button"
            onClick={onOpenMembers}
            aria-label="Members"
            title="Members"
            className="kc-icon-btn flex-shrink-0 text-base"
          >
            <Icon name="members" />
          </button>
        )}
        {channel?.channel_type === "group_dm" && (
          <div className="kc-grpmem-anchor">
            <button
              type="button"
              onClick={() => setShowGroupMembers((v) => !v)}
              aria-label="Group members"
              title="Group members"
              aria-expanded={showGroupMembers}
              className="kc-icon-btn flex-shrink-0 text-base"
            >
              <Icon name="members" />
            </button>
            {showGroupMembers && (
              <GroupMembersPopover
                channel={channel}
                currentUserId={currentUserId}
                token={token}
                seedMembers={groupMembers}
                onToast={onToast}
                onClose={() => setShowGroupMembers(false)}
              />
            )}
          </div>
        )}
        {onWatchControl && (
          <button
            type="button"
            onClick={() => setWatchInput((v) => (v === null ? "" : null))}
            aria-label="Watch party"
            title="Start a watch party"
            aria-pressed={watchInput !== null}
            className={`kc-icon-btn kc-hide-narrow flex-shrink-0${watchInput !== null ? " active" : ""}`}
          >
            <Icon name="tv" />
          </button>
        )}
        {onToggleE2e && (
          <button
            type="button"
            onClick={onToggleE2e}
            aria-label={e2eEnabled ? "Turn off end-to-end encryption" : "Turn on end-to-end encryption"}
            aria-pressed={e2eEnabled}
            title={e2eEnabled ? "End-to-end encrypted — click to turn off" : "Turn on end-to-end encryption"}
            className={`kc-icon-btn flex-shrink-0${e2eEnabled ? " active" : ""}`}
            style={e2eEnabled ? { color: "var(--accent)" } : undefined}
          >
            <Icon name={e2eEnabled ? "lock" : "lockOpen"} />
          </button>
        )}
        {onSetDisappearing && (
          <div className="relative flex-shrink-0">
            <button
              type="button"
              onClick={() => setDisappearOpen((v) => !v)}
              aria-label="Disappearing messages"
              aria-expanded={disappearOpen}
              title={
                channel?.disappearing_seconds
                  ? `Disappearing messages: ${formatDuration(channel.disappearing_seconds)}`
                  : "Disappearing messages"
              }
              className={`kc-icon-btn flex-shrink-0${channel?.disappearing_seconds ? " active" : ""}`}
              style={channel?.disappearing_seconds ? { color: "var(--accent)" } : undefined}
            >
              <Icon name="clock" />
            </button>
            {disappearOpen && (
              <>
                <button
                  type="button"
                  aria-hidden
                  tabIndex={-1}
                  className="fixed inset-0 z-10"
                  style={{ background: "transparent", cursor: "default" }}
                  onClick={() => setDisappearOpen(false)}
                />
                <div
                  className="kc-pop absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-lg py-1"
                  style={{ background: "var(--bg-sidebar)", border: "1px solid var(--bg-hover)" }}
                  role="listbox"
                  aria-label="Disappearing message duration"
                >
                  <div
                    className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    Disappear after
                  </div>
                  {DISAPPEAR_OPTIONS.map((opt) => {
                    const active = (channel?.disappearing_seconds ?? null) === opt.seconds;
                    return (
                      <button
                        key={opt.label}
                        type="button"
                        role="option"
                        aria-selected={active}
                        className="kc-interactive flex w-full items-center justify-between px-3 py-1.5 text-sm"
                        style={{ color: active ? "var(--accent)" : "var(--text-primary)", background: "transparent" }}
                        onClick={() => {
                          onSetDisappearing(opt.seconds);
                          setDisappearOpen(false);
                        }}
                      >
                        <span>{opt.label}</span>
                        {active && <span aria-hidden>✓</span>}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Upload progress */}
      {Object.entries(uploadProgress).length > 0 && (
        <div className="mx-4 mt-2 space-y-1">
          {Object.entries(uploadProgress).map(([name, pct]) => (
            <div key={name} className="rounded px-3 py-1.5 text-xs" style={{ background: "var(--bg-sidebar)" }}>
              <div className="flex justify-between mb-1">
                <span style={{ color: "var(--text-secondary)" }}>{name}</span>
                <span style={{ color: "var(--accent)" }}>{pct}%</span>
              </div>
              <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--bg-input)" }}>
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${pct}%`, background: "var(--accent)" }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {channel?.disappearing_seconds ? (
        <div className="kc-disappear-banner mx-3 mt-2 flex items-center gap-2 rounded-md px-3 py-1.5 text-xs">
          ⏱️{" "}
          <span>
            <strong style={{ color: "var(--text-primary)" }}>Disappearing messages on.</strong> New messages here vanish{" "}
            {formatDuration(channel.disappearing_seconds)} after they're sent.
          </span>
        </div>
      ) : null}

      {e2eEnabled && (
        <>
          {(e2eTrust === "changed_verified" || e2eTrust === "changed_unverified") && (
            <div
              role="alert"
              className="mx-3 mt-2 rounded-md px-3 py-2 text-xs"
              style={{
                background: e2eTrust === "changed_verified" ? "rgba(220,38,38,0.12)" : "rgba(217,119,6,0.12)",
                border: `1px solid ${e2eTrust === "changed_verified" ? "#dc2626" : "#d97706"}`,
                color: "var(--text-primary)",
              }}
            >
              <div className="flex items-start gap-2">
                <span aria-hidden="true">{e2eTrust === "changed_verified" ? "⚠️" : "🔁"}</span>
                <span>
                  {e2eTrust === "changed_verified" ? (
                    <>
                      <strong>Their safety number changed.</strong> You verified this contact before, so unless they
                      reinstalled or added a device, someone may be intercepting. Compare the new number before you
                      trust it.
                    </>
                  ) : (
                    <>
                      <strong>Their safety number changed.</strong> Usually that&apos;s a reinstall or a new device —
                      verify to be sure no one is intercepting.
                    </>
                  )}
                </span>
              </div>
              <div className="mt-2 flex gap-2">
                {onRequestSafetyNumber && (
                  <button
                    type="button"
                    className="kc-interactive rounded px-2 py-0.5 font-semibold whitespace-nowrap"
                    style={{ border: "1px solid var(--accent)", color: "var(--accent)", cursor: "pointer", background: "transparent" }}
                    onClick={() => void openSafetyNumber()}
                  >
                    Verify now
                  </button>
                )}
                {onDismissKeyChange && (
                  <button
                    type="button"
                    className="kc-interactive rounded px-2 py-0.5"
                    style={{ color: "var(--text-secondary)", cursor: "pointer", background: "transparent" }}
                    onClick={onDismissKeyChange}
                  >
                    Dismiss
                  </button>
                )}
              </div>
            </div>
          )}
          <div className="kc-e2e-banner mx-3 mt-2 rounded-md px-3 py-1.5 text-xs">
            <div className="flex items-center gap-2">
              🔒{" "}
              <span>
                <strong>
                  {e2eTrust === "verified" ? "End-to-end encrypted · verified." : "Switched to end-to-end encrypted."}
                </strong>{" "}
                Messages here are encrypted on your device — not even the server can read them.
              </span>
              {e2eTrust === "verified" && (
                <span
                  aria-label="You verified this contact"
                  title="You verified this contact's safety number"
                  className="flex-shrink-0 font-semibold"
                  style={{ color: "#16a34a" }}
                >
                  ✓
                </span>
              )}
              {onRequestSafetyNumber && (
                <button
                  type="button"
                  aria-label="Verify encryption safety number"
                  aria-expanded={safety.open}
                  className="kc-interactive ml-auto flex-shrink-0 rounded px-2 py-0.5 font-semibold whitespace-nowrap"
                  style={{ border: "1px solid var(--accent)", color: "var(--accent)", cursor: "pointer", background: "transparent" }}
                  onClick={() => {
                    if (safety.open) {
                      setSafety((s) => ({ ...s, open: false }));
                      return;
                    }
                    void openSafetyNumber();
                  }}
                >
                  {safety.open ? "Hide" : e2eTrust === "verified" ? "Re-verify" : "Verify"}
                </button>
              )}
            </div>
            {safety.open && (
              <div className="mt-2 border-t pt-2" style={{ borderColor: "var(--bg-hover)" }}>
                {safety.loading ? (
                  <span style={{ color: "var(--text-secondary)" }}>Computing safety number…</span>
                ) : safety.value ? (
                  <>
                    <code className="block font-mono leading-relaxed tracking-wider" style={{ wordBreak: "break-all" }}>
                      {(safety.value.match(/.{1,5}/g) ?? [safety.value]).join(" ")}
                    </code>
                    <span className="mt-1 block" style={{ color: "var(--text-secondary)" }}>
                      Compare these digits with your friend in person or over a call you trust. If they match, no one is
                      intercepting your messages.
                    </span>
                    {onMarkVerified && e2eTrust !== "verified" && (
                      <button
                        type="button"
                        className="kc-interactive mt-2 rounded px-2 py-0.5 font-semibold whitespace-nowrap"
                        style={{ border: "1px solid #16a34a", color: "#16a34a", cursor: "pointer", background: "transparent" }}
                        onClick={() => {
                          onMarkVerified();
                          setSafety((s) => ({ ...s, open: false }));
                        }}
                      >
                        These match — mark verified
                      </button>
                    )}
                  </>
                ) : (
                  <span style={{ color: "var(--text-secondary)" }}>
                    No secure session yet — send a message first, then verify.
                  </span>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Watch party — synced video for this channel */}
      {watchInput !== null && onWatchControl && (
        <form
          className="mx-3 mt-2 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const url = watchInput.trim();
            if (url) onWatchControl("set", { url });
            setWatchInput(null);
          }}
        >
          <input
            // eslint-disable-next-line jsx-a11y/no-autofocus -- inline composer opens on user action; focusing immediately is expected
            autoFocus
            value={watchInput}
            onChange={(e) => setWatchInput(e.target.value)}
            placeholder="Paste a YouTube or video URL to watch together…"
            aria-label="Watch-party video URL"
            className="flex-1 rounded-md px-3 py-1.5 text-sm outline-none"
            style={{ background: "var(--bg-input)", color: "var(--text-primary)", border: "1px solid var(--bg-hover)" }}
          />
          <button
            type="submit"
            className="kc-interactive rounded-md px-3 py-1.5 text-sm font-semibold"
            style={{ background: "var(--accent)", color: "#fff", border: "none", cursor: "pointer" }}
          >
            Start
          </button>
        </form>
      )}
      {watchSession && onWatchControl && (
        <WatchParty session={watchSession} onControl={onWatchControl} />
      )}

      {/* Messages — virtualized */}
      <div className={`flex-1 overflow-hidden relative${e2eEnabled ? " kc-e2e" : ""}`}>
        {/* Screen-reader announcement of the latest message (the list is virtualized). */}
        <div className="sr-only" role="log" aria-live="polite" aria-relevant="additions">
          {displayMessages.length > 0
            ? `${displayMessages[displayMessages.length - 1].author.display_name}: ${displayMessages[displayMessages.length - 1].content}`
            : ""}
        </div>
        {isLoading ? (
          <div className="flex h-full items-center justify-center" style={{ color: "var(--text-muted)" }}>
            <LoadingSpinner />
          </div>
        ) : groups.length === 0 ? (
          <ChannelWelcome
            channelName={channel?.name && channel.name !== "dm" ? channel.name : undefined}
            isDM={channel?.channel_type === "dm" || channel?.channel_type === "group_dm"}
            userId={currentUserId}
            onSaveRecovery={onSaveRecovery}
          />
        ) : (
          <AutoSizedList
            listRef={listRef}
            outerRef={listOuterRef}
            itemCount={groups.length}
            estimatedItemSize={60}
            estimateHeight={estimateHeight}
            onScroll={handleListScroll}
          >
            {({ index, style }: { index: number; style: React.CSSProperties }) => {
              const g = groups[index];
              return (
                <div style={style} className="msg-group px-4 pt-2 hover:bg-white/[0.02]">
                  <div className="flex items-start gap-3">
                    <button
                      className="msg-avatar mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold"
                      style={{ background: avatarBg(g.author.id), color: "#fff", cursor: "pointer", border: "none" }}
                      onClick={(e) => {
                        profileAnchorRef.current = e.currentTarget as HTMLElement;
                        setProfileUserId(g.author.id);
                      }}
                      title={`View ${g.author.display_name}'s profile`}
                    >
                      {g.author.display_name[0]?.toUpperCase()}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="msg-meta flex items-baseline gap-2">
                        <button
                          className="text-sm font-semibold"
                          style={{ color: "var(--text-primary)", cursor: "pointer", background: "none", border: "none", padding: 0 }}
                          onClick={(e) => {
                            profileAnchorRef.current = e.currentTarget as HTMLElement;
                            setProfileUserId(g.author.id);
                          }}
                        >
                          {g.author.display_name}
                        </button>
                        <span className="text-xs" style={{ color: "var(--text-secondary)" }}>
                          {formatTime(g.msgs[0].created_at)}
                        </span>
                      </div>
                      {g.msgs.map((msg, mi) => (
                        <div key={msg.id} data-message-id={msg.id} className="kc-msg">
                          {mi > 0 && (
                            <span className="kc-msg-time">
                              {new Date(msg.created_at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                            </span>
                          )}
                          {msg.pinned && (
                            <div className="mb-0.5 flex items-center gap-1 text-xs" style={{ color: "var(--accent)" }}>
                              📌 <span style={{ fontWeight: 600 }}>Pinned</span>
                            </div>
                          )}
                          {msg.reply_to && <ReplyQuote reply={msg.reply_to} />}
                          {editingId === msg.id ? (
                            <EditBox
                              value={editText}
                              onChange={setEditText}
                              onSave={() => {
                                const t = editText.trim();
                                if (t && t !== msg.content) onEditMessage?.(msg.id, t);
                                setEditingId(null);
                              }}
                              onCancel={() => setEditingId(null)}
                            />
                          ) : msg.poll ? (
                            <PollWidget poll={msg.poll} onVote={(optId) => handleVotePoll(msg.id, optId)} />
                          ) : (
                            <div
                              className="msg-content"
                              style={{ color: "var(--text-secondary)", userSelect: "text", opacity: msg._state === "pending" ? 0.5 : 1 }}
                            >
                              {msg.content && <MessageContent content={msg.content} serverEmojis={serverEmojis} currentUsername={currentUsername} suppressLinkPreviews={!!(msg.embeds && msg.embeds.length)} />}
                              {msg.edited_at && (
                                <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 5 }}>(edited)</span>
                              )}
                              {msg.expires_at && (
                                <span
                                  title="Disappearing message"
                                  style={{ fontSize: 11, color: "var(--accent)", marginLeft: 6 }}
                                >
                                  ⏱️ {timeLeft(msg.expires_at)}
                                </span>
                              )}
                              {msg.attachments && msg.attachments.length > 0 && (
                                <AttachmentList attachments={msg.attachments} />
                              )}
                              {msg.embeds && msg.embeds.length > 0 && msg.embeds.map((em) => (
                                <EmbedCard key={em.url} embed={em} />
                              ))}
                            </div>
                          )}
                          {msg._state === "failed" && (
                            <div className="kc-msg-failed">
                              <span>⚠ Couldn't send.</span>
                              <button type="button" onClick={(e) => { e.stopPropagation(); onRetry?.(msg); }}>Retry</button>
                              <button type="button" className="discard" onClick={(e) => { e.stopPropagation(); onDiscardFailed?.(msg.id); }}>Delete</button>
                            </div>
                          )}
                          {/* Reactions — only render when present */}
                          {(msg.reactions?.length ?? 0) > 0 && (
                            <div className="flex flex-wrap items-center gap-1 mt-1">
                              {(msg.reactions ?? []).map((r) => (
                                <button
                                  key={r.emoji}
                                  type="button"
                                  className="kc-reaction"
                                  data-me={r.me ? "1" : undefined}
                                  onClick={() => handleReact(msg, r.emoji)}
                                >
                                  <span>{r.emoji}</span>
                                  <span className="kc-reaction-n">{r.count}</span>
                                </button>
                              ))}
                            </div>
                          )}
                          {/* Floating action toolbar — appears on hover, top-right */}
                          {editingId !== msg.id && (confirmDeleteId === msg.id ? (
                            <div className="kc-msg-actions" data-confirm="1">
                              <button
                                type="button"
                                className="danger"
                                onClick={(e) => { e.stopPropagation(); onDeleteMessage?.(msg.id); setConfirmDeleteId(null); }}
                              >
                                Delete
                              </button>
                              <button type="button" onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(null); }}>
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <div className="kc-msg-actions">
                              <button
                                type="button"
                                aria-label="Add reaction"
                                title="React"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (emojiPickerFor === msg.id) {
                                    setEmojiPickerFor(null);
                                    setPickerPos(null);
                                  } else {
                                    const rect = (e.currentTarget as HTMLButtonElement).getBoundingClientRect();
                                    setPickerPos({ x: rect.left, y: rect.top });
                                    setEmojiPickerFor(msg.id);
                                  }
                                }}
                              >
                                <Icon name="react" size={16} />
                              </button>
                              <button type="button" aria-label="Reply" title="Reply" onClick={(e) => { e.stopPropagation(); setReplyTarget(msg); }}>
                                <Icon name="reply" size={16} />
                              </button>
                              {onPinMessage && !msg.id.startsWith("temp-") && (
                                <button
                                  type="button"
                                  className={msg.pinned ? "active" : ""}
                                  aria-label={msg.pinned ? "Unpin message" : "Pin message"}
                                  title={msg.pinned ? "Unpin" : "Pin"}
                                  onClick={(e) => { e.stopPropagation(); onPinMessage(msg.id, !msg.pinned); }}
                                >
                                  <Icon name="pin" size={16} />
                                </button>
                              )}
                              {onForward && !msg.id.startsWith("temp-") && (
                                <button type="button" aria-label="Forward message" title="Forward" onClick={(e) => { e.stopPropagation(); onForward(msg); }}>
                                  <Icon name="forward" size={16} />
                                </button>
                              )}
                              {!msg.id.startsWith("temp-") && (
                                <button type="button" aria-label="Save message" title="Save" onClick={(e) => { e.stopPropagation(); handleSave(msg.id); }}>
                                  <Icon name="bookmark" size={16} />
                                </button>
                              )}
                              {g.isMe && onEditMessage && !msg.poll && !msg.id.startsWith("temp-") && (
                                <button type="button" aria-label="Edit message" title="Edit" onClick={(e) => { e.stopPropagation(); setEditingId(msg.id); setEditText(msg.content); }}>
                                  <Icon name="edit" size={16} />
                                </button>
                              )}
                              {g.isMe && onDeleteMessage && !msg.id.startsWith("temp-") && (
                                <button type="button" className="danger" aria-label="Delete message" title="Delete" onClick={(e) => { e.stopPropagation(); setConfirmDeleteId(msg.id); }}>
                                  <Icon name="trash" size={16} />
                                </button>
                              )}
                            </div>
                          ))}
                          {/* Touch: explicit ⋯ trigger → action sheet (hover toolbar is unreachable on touch) */}
                          {editingId !== msg.id && confirmDeleteId !== msg.id && !msg.id.startsWith("temp-") && (
                            <button
                              type="button"
                              className="kc-msg-more"
                              aria-label="Message actions"
                              onClick={(e) => { e.stopPropagation(); setActionSheetMsg(msg); }}
                            >
                              <Icon name="more" size={18} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              );
            }}
          </AutoSizedList>
        )}
        {showJump && (
          <button type="button" className="kc-jump-bottom" onClick={jumpToBottom} aria-label="Jump to latest messages">
            ↓ New messages
          </button>
        )}
      </div>

      {/* Delivered / Seen receipt (DMs only) — sits just above the composer. */}
      <ReceiptLine channel={channel} messages={messages} currentUserId={currentUserId} receipts={receipts} />

      {/* Pending attachments preview */}
      {pendingFiles.length > 0 && (
        <div className="mx-4 flex gap-2 flex-wrap">
          {pendingFiles.map((f) => (
            <div
              key={f.id}
              className="flex items-center gap-1 rounded px-2 py-1 text-xs"
              style={{ background: "var(--bg-input)", color: "var(--text-secondary)" }}
            >
              <span>{fileIcon(f.content_type)}</span>
              <span className="max-w-[120px] truncate">{f.filename}</span>
              <span style={{ color: "var(--text-muted)" }}>{formatBytes(f.size_bytes)}</span>
              <button
                type="button"
                aria-label={`Remove ${f.filename}`}
                onClick={() => setPendingFiles((prev) => prev.filter((p) => p.id !== f.id))}
                className="ml-1 kc-interactive"
                style={{ color: "var(--danger)", background: "none", border: "none", cursor: "pointer" }}
              >
                <span aria-hidden="true">✕</span>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* @-mention autocomplete */}
      {mention && mentionMatches.length > 0 && (
        <div
          className="mx-4 mb-1 overflow-hidden"
          style={{ background: "var(--bg-channel)", border: "1px solid var(--bg-hover)", borderRadius: "var(--radius-md)", boxShadow: "var(--shadow-md)" }}
        >
          {mentionMatches.map((m, i) => (
            <button
              key={m.id}
              type="button"
              onMouseDown={(e) => { e.preventDefault(); pickMention(m.username); }}
              className="kc-interactive flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm"
              style={{ background: i === 0 ? "var(--bg-hover)" : "transparent", border: "none", cursor: "pointer" }}
            >
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-xs font-bold" style={{ background: "var(--accent)", color: "#fff" }}>
                {(m.display_name[0] ?? "?").toUpperCase()}
              </span>
              <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>{m.display_name}</span>
              <span style={{ color: "var(--text-muted)" }}>@{m.username}</span>
            </button>
          ))}
        </div>
      )}

      {/* Typing indicator */}
      {typingUsers.length > 0 && <TypingIndicator users={typingUsers} />}

      {/* Reply chip */}
      {replyTarget && (
        <div
          className="mx-4 mb-1 flex items-center gap-2 rounded-md px-3 py-1.5 text-xs"
          style={{ background: "var(--bg-input)", color: "var(--text-secondary)" }}
        >
          <span style={{ color: "var(--accent)", fontWeight: 700 }}>↩</span>
          <span className="flex-shrink-0">
            Replying to <strong>{replyTarget.author.display_name}</strong>
          </span>
          <span className="truncate flex-1" style={{ color: "var(--text-muted)" }}>
            {replyTarget.content || "attachment"}
          </span>
          <button
            type="button"
            onClick={() => setReplyTarget(null)}
            aria-label="Cancel reply"
            className="kc-interactive flex-shrink-0"
            style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
          >
            ✕
          </button>
        </div>
      )}

      {/* Input */}
      <form
        onSubmit={handleSend}
        className="mx-4 mb-4 flex items-center gap-2 rounded-lg px-4 py-2"
        style={{ background: "var(--bg-input)", marginBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      >
        <button
          type="button"
          onClick={open}
          className="kc-icon-btn flex-shrink-0 text-lg"
          title="Upload a file"
          aria-label="Attach a file"
        >
          <Icon name="plus" size={20} />
        </button>
        <button
          type="button"
          onClick={() => setShowPoll(true)}
          className="kc-icon-btn flex-shrink-0 text-base"
          title="Create a poll"
          aria-label="Create a poll"
        >
          <Icon name="poll" />
        </button>
        <input
          ref={composerRef}
          className="flex-1 bg-transparent text-sm outline-none"
          style={{ color: "var(--text-primary)" }}
          placeholder={
            replyTarget
              ? `Reply to ${replyTarget.author.display_name}…`
              : channel.name !== "dm"
                ? `Say something to #${channel.name}…`
                : "Say something…"
          }
          value={input}
          onChange={(e) => onComposerChange(e.target.value, e.target.selectionStart ?? e.target.value.length)}
          onKeyDown={(e) => {
            if (mention && mentionMatches.length > 0 && (e.key === "Enter" || e.key === "Tab")) {
              e.preventDefault();
              pickMention(mentionMatches[0].username);
              return;
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend(e as unknown as React.FormEvent);
            } else if (e.key === "Escape") {
              if (mention) setMention(null);
              else if (replyTarget) setReplyTarget(null);
            }
          }}
        />
        <button
          type="submit"
          aria-label="Send message"
          className={`kc-icon-btn flex-shrink-0 text-lg${input.trim() || pendingFiles.length > 0 ? " active" : ""}`}
        >
          <Icon name="send" />
        </button>
      </form>

      {actionSheetMsg && (
        <MessageActionSheet
          msg={actionSheetMsg}
          isMine={actionSheetMsg.author.id === currentUserId}
          onReply={() => { setReplyTarget(actionSheetMsg); setActionSheetMsg(null); }}
          onPin={onPinMessage ? () => { onPinMessage(actionSheetMsg.id, !actionSheetMsg.pinned); setActionSheetMsg(null); } : undefined}
          onForward={onForward ? () => { onForward(actionSheetMsg); setActionSheetMsg(null); } : undefined}
          onSave={() => { handleSave(actionSheetMsg.id); setActionSheetMsg(null); }}
          onEdit={onEditMessage && !actionSheetMsg.poll ? () => { setEditingId(actionSheetMsg.id); setEditText(actionSheetMsg.content); setActionSheetMsg(null); } : undefined}
          onDelete={onDeleteMessage ? () => { setConfirmDeleteId(actionSheetMsg.id); setActionSheetMsg(null); } : undefined}
          onClose={() => setActionSheetMsg(null)}
        />
      )}

      {/* Emoji picker portal — escapes the virtualized list overflow */}
      {emojiPickerFor && pickerPos && createPortal(
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions, jsx-a11y/click-events-have-key-events -- event-containment wrapper (keeps clicks inside the picker), not a control
        <div
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "fixed",
            left: pickerPos.x,
            top: pickerPos.y - 184,
            zIndex: 9999,
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            padding: "8px",
            borderRadius: 8,
            background: "var(--bg-sidebar)",
            border: "1px solid var(--bg-hover)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.5)",
            width: 200,
          }}
        >
          {QUICK_EMOJI.map((em) => {
            const msgId = emojiPickerFor;
            const msg = displayMessages.find((m) => m.id === msgId);
            return (
              <button
                key={em}
                onClick={() => {
                  if (msg) handleReact(msg, em);
                  setEmojiPickerFor(null);
                  setPickerPos(null);
                }}
                style={{
                  fontSize: 18,
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  borderRadius: 4,
                  padding: "2px 3px",
                }}
              >
                {em}
              </button>
            );
          })}
        </div>,
        document.body
      )}

      {/* User profile card portal */}
      {profileUserId && (
        <UserProfileCard
          userId={profileUserId}
          token={token}
          anchorRef={profileAnchorRef}
          onClose={() => setProfileUserId(null)}
        />
      )}

      {/* Poll composer */}
      {showPoll && channel && (
        <PollComposer
          token={token}
          channelId={channel.id}
          onClose={() => setShowPoll(false)}
          onError={(m) => onToast(m, "error")}
        />
      )}
    </div>
  );
}

// ── Auto-sized virtual list ───────────────────────────────────────────────────

import { AutoSizer } from "react-virtualized-auto-sizer";

function AutoSizedList({
  listRef,
  outerRef,
  itemCount,
  estimatedItemSize,
  estimateHeight,
  onScroll,
  children,
}: {
  listRef: React.Ref<List>;
  outerRef: React.Ref<HTMLDivElement>;
  itemCount: number;
  estimatedItemSize: number;
  estimateHeight: (index: number) => number;
  onScroll?: () => void;
  children: (props: { index: number; style: React.CSSProperties }) => React.ReactNode;
}) {
  return (
    <AutoSizer
      renderProp={({ width, height }) => (
        <List
          ref={listRef}
          outerRef={outerRef}
          className="kc-touch-scroll"
          width={width ?? 0}
          height={height ?? 0}
          itemCount={itemCount}
          itemSize={estimateHeight}
          estimatedItemSize={estimatedItemSize}
          overscanCount={5}
          onScroll={onScroll}
        >
          {({ index, style }: { index: number; style: React.CSSProperties }) =>
            children({ index, style })
          }
        </List>
      )}
    />
  );
}

// ── Message content renderer ──────────────────────────────────────────────────

function SpoilerSpan({ text }: { text: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <button
      type="button"
      onClick={() => setRevealed((r) => !r)}
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
      {text}
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

function MessageContent({ content, serverEmojis, currentUsername = "", suppressLinkPreviews = false }: { content: string; serverEmojis: ServerEmoji[]; currentUsername?: string; suppressLinkPreviews?: boolean }) {
  // Forwarded message: 【FWD:author】<original content>
  const fwd = content.match(/^【FWD:([^】]*)】([\s\S]*)$/);
  if (fwd) {
    const [, author, rest] = fwd;
    return (
      <>
        <span className="flex items-center gap-1" style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>
          <span style={{ color: "var(--accent)" }}>↪</span> Forwarded from <strong style={{ color: "var(--text-secondary)" }}>{author}</strong>
        </span>
        {rest && <MessageContent content={rest} serverEmojis={serverEmojis} currentUsername={currentUsername} suppressLinkPreviews={suppressLinkPreviews} />}
      </>
    );
  }
  // Big emoji shortcut
  if (content.startsWith("【BIG_EMOJI:") && content.endsWith("】")) {
    const emoji = content.slice(12, -1);
    return <span className="big-emoji-char" style={{ fontSize: "2.5rem", lineHeight: 1.2 }}>{emoji}</span>;
  }

  const emojiMap = new Map(serverEmojis.map((e) => [e.name, e]));

  const parts: React.ReactNode[] = [];
  // Parse code blocks, spoilers, and custom emoji :name:
  const tokenRe = /```([\s\S]*?)```|【SPOILER:(.+?)】|:([a-z0-9_]{2,32}):/g;
  let last = 0;

  for (const match of content.matchAll(tokenRe)) {
    const before = content.slice(last, match.index);
    if (before) parts.push(<InlineText key={last} text={before} serverEmojis={serverEmojis} currentUsername={currentUsername} suppressLinkPreviews={suppressLinkPreviews} />);

    if (match[0].startsWith("```")) {
      parts.push(
        <pre key={match.index} className="code-block" style={{
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
        }}>
          {match[1]}
        </pre>
      );
    } else if (match[2] !== undefined) {
      parts.push(<SpoilerSpan key={match.index} text={match[2]} />);
    } else if (match[3] !== undefined) {
      const customEmoji = emojiMap.get(match[3]);
      if (customEmoji) {
        parts.push(<CustomEmoji key={match.index} emoji={customEmoji} />);
      } else {
        parts.push(`:${match[3]}:`);
      }
    }

    last = match.index! + match[0].length;
  }

  const remainder = content.slice(last);
  if (remainder) parts.push(<InlineText key={last + "r"} text={remainder} serverEmojis={serverEmojis} currentUsername={currentUsername} suppressLinkPreviews={suppressLinkPreviews} />);

  return <>{parts}</>;
}

const ogCache = new Map<string, OgData | null>();
// Auth token for the (now authenticated) link-preview endpoint; kept current by ChatPane.
let ogAuthToken = "";

function useOgPreview(url: string): OgData | null {
  const [data, setData] = useState<OgData | null>(() => ogCache.get(url) ?? null);
  useEffect(() => {
    // Skip only when we already have real data — a cached null means "retry later".
    if (ogCache.get(url) != null) return;
    const controller = new AbortController();
    fetch(`${getApiBase()}/og?url=${encodeURIComponent(url)}`, {
      headers: ogAuthToken ? { Authorization: `Bearer ${ogAuthToken}` } : undefined,
      signal: controller.signal,
    })
      .then((r) => (r.ok ? (r.json() as Promise<OgData>) : Promise.reject(new Error("og failed"))))
      .then((d) => {
        ogCache.set(url, d);
        setData(d);
      })
      .catch((e) => {
        if (e.name !== "AbortError") ogCache.set(url, null);
      });
    return () => controller.abort();
  }, [url]);
  return data;
}

function LinkPreviewCard({ url }: { url: string }) {
  const og = useOgPreview(url);
  if (!og || (!og.title && !og.description && !og.image)) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "flex",
        gap: 10,
        marginTop: 6,
        padding: "10px 12px",
        borderRadius: 6,
        background: "var(--bg-sidebar)",
        borderLeft: "3px solid var(--accent)",
        textDecoration: "none",
        maxWidth: 480,
        overflow: "hidden",
      }}
    >
      {og.image && (
        <img
          src={og.image}
          alt=""
          style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 4, flexShrink: 0 }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        {og.site_name && (
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>
            {og.favicon && (
              <img src={og.favicon} alt="" width={12} height={12} style={{ marginRight: 4, verticalAlign: "middle" }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
            )}
            {og.site_name}
          </div>
        )}
        {og.title && (
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 2,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {og.title}
          </div>
        )}
        {og.description && (
          <div style={{ fontSize: 12, color: "var(--text-secondary)",
            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {og.description}
          </div>
        )}
      </div>
    </a>
  );
}

/** Accept only http(s) URLs — blocks javascript:/data: from third-party OG data. */
function safeHttpUrl(s: string | null | undefined): string | undefined {
  if (!s) return undefined;
  try {
    const u = new URL(s, window.location.origin);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** Server-persisted link-preview card (no client fetch — fields come from the gateway). */
function EmbedCard({ embed }: { embed: Embed }) {
  if (!embed.title && !embed.description && !embed.image) return null;
  const href = safeHttpUrl(embed.url);
  const imageUrl = safeHttpUrl(embed.image);
  const faviconUrl = safeHttpUrl(embed.favicon);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        display: "flex",
        gap: 10,
        marginTop: 6,
        padding: "10px 12px",
        borderRadius: 6,
        background: "var(--bg-sidebar)",
        borderLeft: `3px solid ${embed.color || "var(--accent)"}`,
        textDecoration: "none",
        maxWidth: 480,
        overflow: "hidden",
      }}
    >
      {imageUrl && (
        <img
          src={imageUrl}
          alt=""
          style={{ width: 72, height: 72, objectFit: "cover", borderRadius: 4, flexShrink: 0 }}
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        {embed.site_name && (
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>
            {faviconUrl && (
              <img src={faviconUrl} alt="" width={12} height={12} style={{ marginRight: 4, verticalAlign: "middle" }}
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
            )}
            {embed.site_name}
          </div>
        )}
        {embed.title && (
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 2,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {embed.title}
          </div>
        )}
        {embed.description && (
          <div style={{ fontSize: 12, color: "var(--text-secondary)",
            display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {embed.description}
          </div>
        )}
      </div>
    </a>
  );
}

// Inline text with bold, italic, inline code, and URL detection.
function InlineText({ text, serverEmojis, currentUsername = "", suppressLinkPreviews = false }: { text: string; serverEmojis: ServerEmoji[]; currentUsername?: string; suppressLinkPreviews?: boolean }) {
  const emojiMap = new Map(serverEmojis.map((e) => [e.name, e]));
  const urlRe = /(https?:\/\/[^\s]+)/g;
  const segments: React.ReactNode[] = [];
  const urls: string[] = [];
  let last = 0;

  for (const match of text.matchAll(urlRe)) {
    const before = text.slice(last, match.index);
    if (before) segments.push(...renderInlineMarkdown(before, String(last), currentUsername, emojiMap));
    const url = match[0].replace(/[.,!?)]+$/, "");
    urls.push(url);
    segments.push(
      <a
        key={match.index}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: "var(--accent)", textDecoration: "underline" }}
        onClick={(e) => e.stopPropagation()}
      >
        {url}
      </a>
    );
    last = match.index! + match[0].length;
  }
  const tail = text.slice(last);
  if (tail) segments.push(...renderInlineMarkdown(tail, String(last + "t"), currentUsername, emojiMap));

  return (
    <>
      {segments}
      {!suppressLinkPreviews && urls.map((url) => <LinkPreviewCard key={url} url={url} />)}
    </>
  );
}

function renderMentions(text: string, currentUsername: string, keyPrefix: string): React.ReactNode[] {
  return splitMentions(text).map((seg, i) => {
    if (!seg.mention) return seg.text;
    const m = seg.mention.toLowerCase();
    // @everyone / @here include you, so give them the stronger "you" highlight too.
    const isMe =
      m === "everyone" || m === "here" || (!!currentUsername && m === currentUsername.toLowerCase());
    return (
      <span
        key={`${keyPrefix}-m${i}`}
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

function renderInlineMarkdown(
  text: string,
  keyPrefix: string,
  currentUsername = "",
  _emojiMap?: Map<string, ServerEmoji>
): React.ReactNode[] {
  // Handle bold (**text**), italic (*text*), inline `code`, and @mentions.
  const parts: React.ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let i = 0;

  for (const match of text.matchAll(re)) {
    if (match.index! > last) parts.push(...renderMentions(text.slice(last, match.index), currentUsername, `${keyPrefix}-p${i}`));
    const token = match[0];
    const key = `${keyPrefix}-${i++}`;
    if (token.startsWith("**")) {
      parts.push(<strong key={key} style={{ color: "var(--text-primary)" }}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      parts.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      parts.push(
        <code key={key} style={{
          background: "var(--bg-input)",
          padding: "1px 5px",
          borderRadius: 3,
          fontFamily: "monospace",
          fontSize: "0.9em",
          color: "var(--text-primary)",
        }}>
          {token.slice(1, -1)}
        </code>
      );
    }
    last = match.index! + token.length;
  }
  parts.push(...renderMentions(text.slice(last), currentUsername, `${keyPrefix}-end`));
  return parts;
}

// ── Attachment list ───────────────────────────────────────────────────────────

/** Scale (w,h) to fit within (maxW,maxH), preserving aspect ratio, never upscaling. */
function fitImg(w: number, h: number, maxW: number, maxH: number): { w: number; h: number } {
  const scale = Math.min(maxW / w, maxH / h, 1);
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

/** A stable, distinguishable avatar background derived from a user id. */
function avatarBg(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `linear-gradient(135deg, oklch(70% 0.13 ${h}), oklch(60% 0.15 ${(h + 28) % 360}))`;
}

function AttachmentList({ attachments }: { attachments: AttachmentMeta[] }) {
  if (!attachments.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {attachments.map((att) => {
        const url = `${getFileBase()}/files/${att.id}`;
        if (att.content_type.startsWith("image/")) {
          const d = att.width && att.height ? fitImg(att.width, att.height, 400, 300) : null;
          return (
            <a key={att.id} href={url} target="_blank" rel="noopener noreferrer" style={{ display: "block" }}>
              <div className="kc-img-frame" style={d ? { width: d.w, height: d.h } : { maxWidth: 400 }}>
                <img
                  className="kc-img"
                  src={url}
                  alt={att.filename}
                  loading="lazy"
                  width={d?.w}
                  height={d?.h}
                  style={d ? undefined : { maxWidth: 400, maxHeight: 300 }}
                />
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                {att.filename} · {formatBytes(att.size_bytes)}
              </div>
            </a>
          );
        }
        if (att.content_type.startsWith("video/")) {
          return (
            <div key={att.id}>
              <video
                src={url}
                controls
                style={{ maxWidth: 320, maxHeight: 240, borderRadius: 6, display: "block" }}
              />
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                {att.filename} · {formatBytes(att.size_bytes)}
              </div>
            </div>
          );
        }
        if (att.content_type.startsWith("audio/")) {
          return (
            <div key={att.id}>
              <audio src={url} controls style={{ maxWidth: 300 }} />
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                {att.filename} · {formatBytes(att.size_bytes)}
              </div>
            </div>
          );
        }
        return (
          <a
            key={att.id}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="link-preview"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 8px",
              borderRadius: 4,
              background: "var(--bg-input)",
              fontSize: 12,
              color: "var(--accent)",
              textDecoration: "none",
            }}
          >
            {fileIcon(att.content_type)} {att.filename}
            <span style={{ color: "var(--text-muted)" }}>{formatBytes(att.size_bytes)}</span>
          </a>
        );
      })}
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function EditBox({
  value, onChange, onSave, onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mt-0.5">
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus -- inline message editor opens on user action; focusing immediately is expected
        autoFocus
        value={value}
        aria-label="Edit message"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); onSave(); }
          else if (e.key === "Escape") onCancel();
        }}
        className="kc-field w-full px-2.5 py-1.5 text-sm outline-none"
      />
      <div className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
        escape to{" "}
        <button type="button" onClick={onCancel} className="kc-interactive" style={{ color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}>cancel</button>
        {" · "}enter to{" "}
        <button type="button" onClick={onSave} className="kc-interactive" style={{ color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}>save</button>
      </div>
    </div>
  );
}

function ReplyQuote({ reply }: { reply: NonNullable<Message["reply_to"]> }) {
  return (
    <div
      className="mb-0.5 flex items-center gap-1.5 text-xs"
      style={{ color: "var(--text-muted)", maxWidth: "100%" }}
      title={`Replying to ${reply.author}`}
    >
      <span style={{ color: "var(--accent)", flexShrink: 0 }}>↩</span>
      <span style={{ fontWeight: 600, color: "var(--text-secondary)", flexShrink: 0 }}>{reply.author}</span>
      <span className="truncate" style={{ opacity: 0.85 }}>{reply.content}</span>
    </div>
  );
}

function TypingIndicator({ users }: { users: PublicUser[] }) {
  const names = users.map((u) => u.display_name);
  let text: string;
  if (names.length === 1) text = `${names[0]} is typing`;
  else if (names.length === 2) text = `${names[0]} and ${names[1]} are typing`;
  else text = `${names[0]}, ${names[1]} and ${names.length - 2} more are typing`;
  return (
    <div className="mx-4 mb-1 flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }} aria-live="polite" aria-atomic="true">
      <span className="kc-typing-dots" aria-hidden>
        <i />
        <i />
        <i />
      </span>
      <span className="truncate">{text}…</span>
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="kc-loader">
        <BirdMark size={40} />
      </div>
      <div className="text-sm" style={{ color: "var(--text-muted)" }}>
        One sec, getting things ready
      </div>
    </div>
  );
}

function formatTime(unix: number): string {
  const d = new Date(unix * 1000);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString() + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB`;
}

function fileIcon(contentType: string): string {
  if (contentType.startsWith("image/")) return "🖼";
  if (contentType.startsWith("video/")) return "🎬";
  if (contentType.startsWith("audio/")) return "🎵";
  if (contentType.includes("pdf")) return "📄";
  if (contentType.includes("zip") || contentType.includes("tar")) return "🗜";
  return "📎";
}

// Suppress unused import warning — ReactionGroup is used via Message type
const _rg: ReactionGroup | null = null;
void _rg;
