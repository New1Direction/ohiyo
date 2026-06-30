import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDropzone } from "react-dropzone";
import { VariableSizeList as List } from "react-window";
import type { AttachmentMeta, Embed, Message, Channel, ReactionGroup, ServerEmoji, PublicUser } from "../api";
import type { WatchSession } from "../gateway";
import { isEncryptedAttachment, type EncryptedAttachmentMeta } from "../lib/encryptedPayload";
import type { TrustState } from "../lib/identityTrust";
import { WatchParty } from "./WatchParty";
import { ErrorBoundary } from "./ErrorBoundary";
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
import { safeHttpUrl } from "../lib/url";
import { Icon } from "./Icon";
import { MessageActionSheet } from "./MessageActionSheet";

// Composer drafts persisted per channel so a half-written message survives a reload,
// not just a channel switch. Cleared on send.
const DRAFT_PREFIX = "kc:draft:";
const HIDDEN_MESSAGES_PREFIX = "kc:hidden-messages:";
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
function hiddenMessagesKey(channelId: string, userId: string): string {
  return `${HIDDEN_MESSAGES_PREFIX}${userId || "anonymous"}:${channelId}`;
}
function loadHiddenMessages(channelId: string, userId: string): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(hiddenMessagesKey(channelId, userId)) || "[]"));
  } catch {
    return new Set();
  }
}
function saveHiddenMessages(channelId: string, userId: string, ids: Set<string>) {
  try {
    const key = hiddenMessagesKey(channelId, userId);
    if (ids.size) localStorage.setItem(key, JSON.stringify([...ids]));
    else localStorage.removeItem(key);
  } catch {
    /* storage off */
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

// Auth token for the (authenticated) link-preview endpoint, passed down via context
// so the deeply-nested LinkPreviewCard can read it without a module-level mutable
// `let` written during render (which is a side effect in render, and not concurrent-safe).
const OgAuthTokenContext = createContext<string>("");

const QUICK_EMOJI = ["👍", "❤️", "😂", "😮", "😢", "🔥", "✅", "🎉", "👀", "🚀", "💯", "🙏", "😍", "😎", "🤔"];
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
// Tenor API key. Prefer VITE_TENOR_KEY (set per-deployment); the public sample key
// from Tenor's docs is a rate-limited DEV-ONLY fallback so the GIF picker still works
// locally without setup. Production deployments should set VITE_TENOR_KEY.
const TENOR_SAMPLE_KEY = "LIVDSRZULELA";
const TENOR_KEY = import.meta.env.VITE_TENOR_KEY || TENOR_SAMPLE_KEY;
type GifResult = { id: string; title: string; url: string; preview: string };

export type ChatActivityNotice = {
  id: string;
  kind: "join" | "leave";
  text: string;
  createdAt: number;
  user?: PublicUser;
};

// Row model for the virtualized message list. Hoisted to module scope so the type
// (and the memoized derivations that use it) is stable across renders.
type MsgGroup = { author: Message["author"]; msgs: Message[]; isMe: boolean };
type ChatRow = { kind: "messages"; group: MsgGroup } | { kind: "activity"; notice: ChatActivityNotice };

type Props = {
  channel: Channel | null;
  messages: Message[];
  dmTabs?: Channel[];
  dmUsers?: Record<string, PublicUser>;
  onSelectDmTab?: (channel: Channel) => void;
  onNewDm?: () => void;
  currentUserId: string;
  token: string;
  pluginManager: PluginManager;
  serverEmojis: ServerEmoji[];
  onSend: (content: string, attachmentIds?: string[], replyTo?: string | null, encryptedAttachments?: EncryptedAttachmentMeta[]) => void;
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
  onReportMessage?: (msg: Message) => void;
  onSaveRecovery?: () => void;
  onOpenSearch?: () => void;
  onOpenMembers?: () => void;
  /** Open/start a direct message from a user's profile card. */
  onOpenDm?: (user: PublicUser) => void | Promise<void>;
  onBlockUser?: (user: PublicUser) => void | Promise<void>;
  onReportUser?: (user: PublicUser) => void | Promise<void>;
  /** Members offered in the @-mention autocomplete (current server). */
  mentionables?: PublicUser[];
  /** People who belong to the current server/channel context, used for the friendly "who's here" header. */
  channelMembers?: PublicUser[];
  /** User ids currently online. */
  onlineUserIds?: Set<string>;
  /** Soft local activity notes like "Mina joined". These are not persisted to message history. */
  activityNotices?: ChatActivityNotice[];
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

function dmTabLabel(channel: Channel, user?: PublicUser): string {
  if (user) return user.display_name || user.username;
  if (channel.channel_type === "group_dm") return channel.name || "Group";
  return channel.name !== "dm" ? channel.name : "DM";
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
  width?: number | null;
  height?: number | null;
  encrypted?: EncryptedAttachmentMeta["encrypted"];
  previewUrl?: string;
};

function b64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function unb64Url(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

async function encryptAttachmentFile(file: File): Promise<{ blob: Blob; encrypted: EncryptedAttachmentMeta["encrypted"] }> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const rawKey = new Uint8Array(await crypto.subtle.exportKey("raw", key));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = await file.arrayBuffer();
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  return {
    blob: new Blob([cipher], { type: "application/octet-stream" }),
    encrypted: {
      alg: "AES-256-GCM",
      key: b64Url(rawKey),
      iv: b64Url(iv),
      cipher_size_bytes: cipher.byteLength,
    },
  };
}

async function decryptAttachmentBytes(att: EncryptedAttachmentMeta, encryptedBytes: ArrayBuffer): Promise<Blob> {
  const key = await crypto.subtle.importKey("raw", unb64Url(att.encrypted.key), { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64Url(att.encrypted.iv) }, key, encryptedBytes);
  return new Blob([plain], { type: att.content_type || "application/octet-stream" });
}

export function ChatPane({
  channel,
  messages,
  dmTabs = [],
  dmUsers = {},
  onSelectDmTab,
  onNewDm,
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
  onReportMessage,
  onSaveRecovery,
  onOpenSearch,
  onOpenMembers,
  onOpenDm,
  onBlockUser,
  onReportUser,
  mentionables = [],
  channelMembers = [],
  onlineUserIds = new Set<string>(),
  activityNotices = [],
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
  const prevChannelRef = useRef<string | null>(channel?.id ?? null);
  const [mention, setMention] = useState<{ query: string; at: number } | null>(null);
  const [replyTarget, setReplyTarget] = useState<Message | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [hiddenMessageIds, setHiddenMessageIds] = useState<Set<string>>(() => (channel?.id ? loadHiddenMessages(channel.id, currentUserId) : new Set()));
  const [showPoll, setShowPoll] = useState(false);
  const lastTypingRef = useRef(0);
  const [pendingFiles, setPendingFiles] = useState<UploadedFile[]>([]);
  const [_uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  const [emojiPickerFor, setEmojiPickerFor] = useState<string | null>(null);
  const [pickerPos, setPickerPos] = useState<{ x: number; y: number } | null>(null);
  const [composerPickerOpen, setComposerPickerOpen] = useState(false);
  const [composerPickerTab, setComposerPickerTab] = useState<"emoji" | "gif">("emoji");
  const [emojiQuery, setEmojiQuery] = useState("");
  const [gifQuery, setGifQuery] = useState("excited");
  const [gifResults, setGifResults] = useState<GifResult[]>([]);
  const [gifLoading, setGifLoading] = useState(false);
  const [gifUrl, setGifUrl] = useState("");
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

  function insertComposerText(text: string) {
    if (!channel) return;
    const el = composerRef.current;
    const start = el?.selectionStart ?? input.length;
    const end = el?.selectionEnd ?? start;
    const padLeft = start > 0 && !/\s$/.test(input.slice(0, start)) ? " " : "";
    const padRight = end < input.length && !/^\s/.test(input.slice(end)) ? " " : "";
    const inserted = `${padLeft}${text}${padRight}`;
    const next = input.slice(0, start) + inserted + input.slice(end);
    const caret = start + inserted.length;
    setInput(next);
    inputRef.current = next;
    draftsRef.current[channel.id] = next;
    persistDraft(channel.id, next);
    setMention(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret, caret);
    });
  }

  function sendGif(url: string) {
    if (!channel) return;
    const trimmed = url.trim();
    if (!/^https?:\/\//i.test(trimmed)) {
      onToast("Paste a valid GIF link", "error");
      return;
    }
    forceBottomRef.current = true;
    onSend(trimmed, [], replyTarget?.id ?? null);
    setInput("");
    inputRef.current = "";
    draftsRef.current[channel.id] = "";
    persistDraft(channel.id, "");
    setReplyTarget(null);
    setGifUrl("");
    setComposerPickerOpen(false);
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
    const last = rows.length - 1;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rows is derived from messages/activityNotices (declared below); re-running on those already covers rows.length
  }, [messages, activityNotices, hiddenMessageIds]);

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
    const last = rows.length - 1;
    if (last >= 0) listRef.current?.scrollToItem(last, "end");
    atBottomRef.current = true;
    setShowJump(false);
  }

  // Reset the typing-ping throttle when switching channels so the first
  // keystroke in a new channel always fires.
  useEffect(() => {
    lastTypingRef.current = 0;
    const local = channel?.id ? loadHiddenMessages(channel.id, currentUserId) : new Set<string>();
    setHiddenMessageIds(local);
    if (channel?.id) {
      void api.listHiddenMessages(token, channel.id).then((ids) => {
        const merged = new Set([...local, ...ids]);
        saveHiddenMessages(channel.id, currentUserId, merged);
        setHiddenMessageIds(merged);
      }).catch(() => {});
    }
  }, [channel?.id, currentUserId, token]);

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

  // Close reaction emoji picker on outside click.
  useEffect(() => {
    if (!emojiPickerFor) return;
    const close = () => setEmojiPickerFor(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [emojiPickerFor]);

  // GIF search: uses Tenor's public sample API key from their docs. If it fails,
  // the picker still supports pasting any GIF URL.
  useEffect(() => {
    if (!composerPickerOpen || composerPickerTab !== "gif") return;
    const q = gifQuery.trim();
    if (!q) {
      setGifResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setGifLoading(true);
      fetch(`https://g.tenor.com/v1/search?q=${encodeURIComponent(q)}&key=${TENOR_KEY}&limit=18&media_filter=minimal`, { signal: controller.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("gif search failed"))))
        .then((data: { results?: Array<{ id: string; title?: string; media?: Array<{ gif?: { url: string }; tinygif?: { url: string } }> }> }) => {
          const results = (data.results ?? [])
            .map((g) => {
              const media = g.media?.[0];
              const url = media?.gif?.url;
              const preview = media?.tinygif?.url ?? url;
              return url && preview ? { id: g.id, title: g.title || "GIF", url, preview } : null;
            })
            .filter((g): g is GifResult => Boolean(g));
          setGifResults(results);
        })
        .catch((err) => {
          if (err.name !== "AbortError") setGifResults([]);
        })
        .finally(() => setGifLoading(false));
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [composerPickerOpen, composerPickerTab, gifQuery]);

  // Apply plugin message transforms. Memoized so react-window's VariableSizeList
  // doesn't get fresh array identities (and discard its measured-height cache) on
  // every unrelated render.
  const displayMessages = useMemo(
    () =>
      messages
        .map((m) => pluginManager.applyMessageTransforms(m))
        .filter((m): m is Message => m !== null),
    [messages, pluginManager]
  );

  // Group consecutive messages by same author, then add soft local activity notes
  // as lightweight rows. These notices feel like chat activity without polluting
  // the real persisted message history.
  const groups = useMemo(() => {
    const out: MsgGroup[] = [];
    for (const msg of displayMessages) {
      const last = out[out.length - 1];
      if (last && last.author.id === msg.author.id) {
        last.msgs.push(msg);
      } else {
        out.push({ author: msg.author, msgs: [msg], isMe: msg.author.id === currentUserId });
      }
    }
    return out;
  }, [displayMessages, currentUserId]);

  const rows = useMemo<ChatRow[]>(
    () => [
      ...groups.map((group) => ({ kind: "messages" as const, group })),
      ...activityNotices.map((notice) => ({ kind: "activity" as const, notice })),
    ],
    [groups, activityNotices]
  );

  // Stable identity so VariableSizeList keeps the same itemSize callback (it caches
  // measured heights against it). Reads metricsRef.current (a ref, not a dep).
  const estimateHeight = useCallback(
    (index: number): number => {
      const row = rows[index];
      if (!row) return 60;
      if (row.kind === "activity") return 48;
      const g = row.group;
      const { linePx, basePx, fontScale } = metricsRef.current;
      // Fewer characters fit per line as the font scales up, so the wrap estimate tracks it.
      const charsPerLine = Math.max(20, Math.round(80 / fontScale));
      const textLines = g.msgs.reduce((sum, m) => sum + (hiddenMessageIds.has(m.id) ? 1 : Math.ceil(m.content.length / charsPerLine)), 0);
      // Reserve the rendered attachment height so images/videos do not get clipped in the virtualized list.
      const mediaH = g.msgs.reduce(
        (sum, m) =>
          sum +
          (hiddenMessageIds.has(m.id) ? 0 : (m.attachments ?? []).reduce((s, a) => {
            if (a.content_type.startsWith("image/")) {
              return s + (a.width && a.height ? fitImg(a.width, a.height, 400, 300).h + 20 : 180);
            }
            if (a.content_type.startsWith("video/")) return s + 278;
            if (a.content_type.startsWith("audio/")) return s + 58;
            return s + 34;
          }, 0)),
        0
      );
      const hasReactions = g.msgs.some((m) => (m.reactions?.length ?? 0) > 0);
      const replies = g.msgs.filter((m) => m.reply_to).length;
      const pins = g.msgs.filter((m) => m.pinned).length;
      const failed = g.msgs.filter((m) => m._state === "failed").length;
      const pollH = g.msgs.reduce((sum, m) => sum + (m.poll ? 70 + m.poll.options.length * 38 : 0), 0);
      const embedsH = g.msgs.reduce((sum, m) => sum + (m.embeds?.length ?? 0) * 92, 0);
      return basePx + Math.max(textLines, 1) * linePx + mediaH + (hasReactions ? 32 : 0) + replies * 22 + pins * 20 + failed * 26 + pollH + embedsH;
    },
    [rows, hiddenMessageIds]
  );

  const handleSend = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const transformed = pluginManager.applyTransformSend(input.trim());
      if (!transformed && pendingFiles.length === 0) return;
      if (!channel) return;
      forceBottomRef.current = true; // always follow your own message to the bottom
      const encryptedAttachments = pendingFiles
        .filter((f): f is UploadedFile & { encrypted: EncryptedAttachmentMeta["encrypted"] } => Boolean(f.encrypted))
        .map((f): EncryptedAttachmentMeta => ({
          id: f.id,
          url: f.url,
          filename: f.filename,
          content_type: f.content_type,
          size_bytes: f.size_bytes,
          width: f.width ?? null,
          height: f.height ?? null,
          encrypted: f.encrypted,
        }));
      onSend(transformed, pendingFiles.map((f) => f.id), replyTarget?.id ?? null, encryptedAttachments.length ? encryptedAttachments : undefined);
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
        const encryptedUpload = e2eEnabled ? await encryptAttachmentFile(file) : null;
        const uploadFile = encryptedUpload
          ? new File([encryptedUpload.blob], "encrypted.bin", { type: "application/octet-stream" })
          : file;
        formData.append("file", uploadFile);

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
                if (encryptedUpload) {
                  results.push(
                    ...data.map((item) => ({
                      ...item,
                      filename: file.name,
                      content_type: file.type || "application/octet-stream",
                      size_bytes: file.size,
                      width: null,
                      height: null,
                      encrypted: encryptedUpload.encrypted,
                      previewUrl: URL.createObjectURL(file),
                    }))
                  );
                } else {
                  results.push(...data);
                }
                resolve();
              } else {
                const serverText = xhr.responseText?.trim();
                const reason = serverText || (xhr.status === 413 ? "file is too large for this server" : `HTTP ${xhr.status}`);
                reject(new Error(reason));
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
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          onToast(`Upload failed: ${file.name} (${formatBytes(file.size)}): ${reason}`, "error");
        }
      }

      setPendingFiles((prev) => [...prev, ...results]);
      setUploading(false);
    },
    [token, onToast, e2eEnabled]
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

  function hideMessageForMe(messageId: string) {
    if (!channel) return;
    void api.hideMessage(token, channel.id, messageId, true).catch(() => {});
    setHiddenMessageIds((prev) => {
      const next = new Set(prev);
      next.add(messageId);
      saveHiddenMessages(channel.id, currentUserId, next);
      return next;
    });
    onToast("Hidden for you", "info");
  }

  function unhideMessageForMe(messageId: string) {
    if (!channel) return;
    void api.hideMessage(token, channel.id, messageId, false).catch(() => {});
    setHiddenMessageIds((prev) => {
      const next = new Set(prev);
      next.delete(messageId);
      saveHiddenMessages(channel.id, currentUserId, next);
      return next;
    });
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

  const peopleHere = channelMembers
    .filter((member, index, all) => all.findIndex((m) => m.id === member.id) === index)
    .sort((a, b) => Number(onlineUserIds.has(b.id)) - Number(onlineUserIds.has(a.id)) || a.display_name.localeCompare(b.display_name));
  const onlineHereCount = peopleHere.filter((member) => onlineUserIds.has(member.id)).length;
  const memberSummary = peopleHere.length > 0
    ? `${peopleHere.length} ${peopleHere.length === 1 ? "person" : "people"}${onlineHereCount ? ` · ${onlineHereCount} online` : ""}`
    : "People";
  const isDirectChat = channel.channel_type === "dm" || channel.channel_type === "group_dm";
  const visibleDmTabs = isDirectChat
    ? [channel, ...dmTabs.filter((dm) => dm.id !== channel.id)].slice(0, 6)
    : [];

  return (
    <OgAuthTokenContext.Provider value={token}>
    <div className="flex flex-1 flex-col" style={{ background: "var(--bg-channel)" }} {...getRootProps()}>
      <input {...getInputProps({ "aria-label": "Attach files" })} />

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

      {visibleDmTabs.length > 0 && (
        <div className="kc-dm-tabs" role="tablist" aria-label="Open direct messages">
          {visibleDmTabs.map((dm) => {
            const label = dmTabLabel(dm, dmUsers[dm.id]);
            const active = dm.id === channel.id;
            const other = dmUsers[dm.id];
            return (
              <button
                key={dm.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onSelectDmTab?.(dm)}
                className="kc-dm-tab kc-interactive"
                title={label}
              >
                <span
                  className="kc-dm-tab__avatar"
                  style={{
                    background: avatarBg(other?.id ?? dm.id),
                    backgroundImage: other?.avatar_url ? `url(${assetUrl(other.avatar_url)})` : undefined,
                  }}
                  aria-hidden="true"
                >
                  {!other?.avatar_url && label[0]?.toUpperCase()}
                </span>
                <span className="kc-dm-tab__label">{label}</span>
              </button>
            );
          })}
          {onNewDm && (
            <button
              type="button"
              className="kc-dm-tab kc-dm-tab--new kc-interactive"
              onClick={onNewDm}
              aria-label="Start a new DM"
              title="Start a new DM"
            >
              +
            </button>
          )}
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
        {peopleHere.length > 0 && onOpenMembers && (
          <button
            type="button"
            onClick={onOpenMembers}
            className="kc-interactive flex items-center gap-2 rounded-full px-2.5 py-1 text-xs font-semibold"
            style={{
              background: "color-mix(in oklch, var(--accent) 8%, var(--bg-input))",
              border: "1px solid color-mix(in oklch, var(--accent) 18%, var(--bg-hover))",
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
            aria-label={`See who's here: ${memberSummary}`}
            title="See who's here"
          >
            <span className="flex -space-x-2" aria-hidden="true">
              {peopleHere.slice(0, 4).map((member) => (
                <span
                  key={member.id}
                  className="relative flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold ring-2"
                  style={{
                    background: avatarBg(member.id),
                    backgroundImage: member.avatar_url ? `url(${assetUrl(member.avatar_url)})` : undefined,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                    color: "#fff",
                    boxShadow: onlineUserIds.has(member.id) ? "0 0 0 2px color-mix(in oklch, var(--success, #22c55e) 72%, white)" : undefined,
                    border: "2px solid var(--bg-channel)",
                  }}
                >
                  {!member.avatar_url && member.display_name[0]?.toUpperCase()}
                </span>
              ))}
            </span>
            <span>{memberSummary}</span>
          </button>
        )}
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
                onOpenDm={onOpenDm}
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

      {channel?.imported ? (
        <div
          className="mx-3 mt-2 flex items-start gap-2 rounded-md px-3 py-2 text-xs"
          style={{
            background: "color-mix(in oklch, var(--gold, #f59e0b) 11%, var(--bg-elevated))",
            border: "1px solid color-mix(in oklch, var(--gold, #f59e0b) 36%, var(--bg-input))",
            color: "var(--text-secondary)",
          }}
        >
          <span aria-hidden="true">📦</span>
          <span>
            <strong style={{ color: "var(--text-primary)" }}>Imported Discord archive.</strong> This history is preserved as plaintext archive content and marked not E2E. Native Ohiyo DMs and group chats can still be encrypted.
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
        <ErrorBoundary label="Watch party">
          <WatchParty session={watchSession} onControl={onWatchControl} />
        </ErrorBoundary>
      )}

      {/* Messages — virtualized */}
      <div className={`flex-1 overflow-hidden relative${e2eEnabled ? " kc-e2e" : ""}`}>
        {/* Screen-reader announcement of the latest message (the list is virtualized). */}
        <div className="sr-only" role="log" aria-live="polite" aria-relevant="additions">
          {displayMessages.length > 0
            ? `${displayMessages[displayMessages.length - 1].author.display_name}: ${displayMessages[displayMessages.length - 1].content}`
            : ""}
        </div>
        {/* A plugin message transform or a row renderer throwing degrades this
            region to a fallback instead of taking down the whole app. */}
        <ErrorBoundary label="Messages">
        {isLoading ? (
          <div className="flex h-full items-center justify-center" style={{ color: "var(--text-muted)" }}>
            <LoadingSpinner />
          </div>
        ) : rows.length === 0 ? (
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
            itemCount={rows.length}
            estimatedItemSize={60}
            estimateHeight={estimateHeight}
            onScroll={handleListScroll}
          >
            {({ index, style }: { index: number; style: React.CSSProperties }) => {
              const row = rows[index];
              if (row.kind === "activity") {
                return <ActivityNoticeRow key={row.notice.id} notice={row.notice} style={style} />;
              }
              const g = row.group;
              return (
                <div style={style} className="msg-group px-4 pt-2 hover:bg-white/[0.02]">
                  <div className="flex items-start gap-3">
                    <button
                      className="msg-avatar mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full text-sm font-bold"
                      style={{
                        background: avatarBg(g.author.id),
                        backgroundImage: g.author.avatar_url ? `url(${assetUrl(g.author.avatar_url)})` : undefined,
                        backgroundSize: "cover",
                        backgroundPosition: "center",
                        color: "#fff",
                        cursor: "pointer",
                        border: "none",
                      }}
                      onClick={(e) => {
                        profileAnchorRef.current = e.currentTarget as HTMLElement;
                        setProfileUserId(g.author.id);
                      }}
                      title={`View ${g.author.display_name}'s profile`}
                    >
                      {!g.author.avatar_url && g.author.display_name[0]?.toUpperCase()}
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
                          {hiddenMessageIds.has(msg.id) ? (
                            <HiddenMessageNotice
                              authorName={msg.author.display_name}
                              onUndo={() => unhideMessageForMe(msg.id)}
                            />
                          ) : editingId === msg.id ? (
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
                          ) : msg._decryptState ? (
                            <UndecryptableMessage state={msg._decryptState} onOpenRecovery={onSaveRecovery} />
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
                                <button type="button" aria-label="Hide message for me" title="Hide for me" onClick={(e) => { e.stopPropagation(); hideMessageForMe(msg.id); }}>
                                  <Icon name="trash" size={16} />
                                </button>
                              )}
                              {!g.isMe && onReportMessage && !msg.id.startsWith("temp-") && (
                                <button type="button" className="danger" aria-label="Report message" title="Report" onClick={(e) => { e.stopPropagation(); onReportMessage(msg); }}>
                                  <Icon name="flag" size={16} />
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
        </ErrorBoundary>
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
        <div className="kc-composer-files mx-4 mb-2 flex gap-2 flex-wrap">
          {pendingFiles.map((f) => (
            <PendingAttachmentPreview
              key={f.id}
              file={f}
              onRemove={() => setPendingFiles((prev) => prev.filter((p) => p.id !== f.id))}
            />
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
        <div className="kc-composer-reply mx-4 mb-2 flex items-center gap-2 px-3 py-1.5 text-xs">
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

      {composerPickerOpen && (
        <ComposerMediaPicker
          tab={composerPickerTab}
          onTab={setComposerPickerTab}
          emojiQuery={emojiQuery}
          onEmojiQuery={setEmojiQuery}
          serverEmojis={serverEmojis}
          onPickEmoji={(em) => insertComposerText(em)}
          onPickCustomEmoji={(em) => insertComposerText(`:${em.name}:`)}
          gifQuery={gifQuery}
          onGifQuery={setGifQuery}
          gifResults={gifResults}
          gifLoading={gifLoading}
          gifUrl={gifUrl}
          onGifUrl={setGifUrl}
          onSendGif={sendGif}
        />
      )}

      {/* Input */}
      <form
        onSubmit={handleSend}
        className="kc-composer-shell mx-4 mb-4"
        style={{ marginBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      >
        <div className="kc-composer-tools" aria-label="Message tools">
          <button
            type="button"
            onClick={open}
            className="kc-icon-btn flex-shrink-0 text-lg"
            title="Upload a file"
            aria-label="Attach a file"
          >
            <Icon name="plus" size={18} />
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
          <button
            type="button"
            onClick={() => {
              setComposerPickerOpen((v) => !v);
              setComposerPickerTab("emoji");
            }}
            className={`kc-icon-btn flex-shrink-0 text-base${composerPickerOpen ? " active" : ""}`}
            title="Emoji and GIFs"
            aria-label="Emoji and GIFs"
            aria-expanded={composerPickerOpen}
          >
            <Icon name="react" />
          </button>
        </div>
        <input
          ref={composerRef}
          className="kc-composer-input flex-1 bg-transparent text-sm outline-none"
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
          className={`kc-composer-send kc-icon-btn flex-shrink-0 text-lg${input.trim() || pendingFiles.length > 0 ? " active" : ""}`}
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
          onHide={() => { hideMessageForMe(actionSheetMsg.id); setActionSheetMsg(null); }}
          onReport={onReportMessage ? () => { onReportMessage(actionSheetMsg); setActionSheetMsg(null); } : undefined}
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
          currentUserId={currentUserId}
          onOpenDm={onOpenDm}
          onBlockUser={onBlockUser}
          onReportUser={onReportUser}
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
    </OgAuthTokenContext.Provider>
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

function UndecryptableMessage({ state, onOpenRecovery }: { state: "unknown" | "not_covered" | "restore_failed"; onOpenRecovery?: () => void }) {
  const restoredButFailed = state === "restore_failed";
  const notCovered = state === "not_covered";
  return (
    <div className="mt-1 max-w-md rounded-2xl border p-3 text-xs" style={{ background: "color-mix(in oklch, var(--accent) 7%, var(--bg-elevated))", borderColor: "color-mix(in oklch, var(--accent) 22%, var(--bg-hover))", color: "var(--text-muted)" }}>
      <div className="font-bold" style={{ color: "var(--text-primary)" }}>
        {notCovered ? "This old message was not in your recovery backup" : restoredButFailed ? "This message still can’t be decrypted" : "This message needs keys this device doesn’t have"}
      </div>
      <p className="mt-1 leading-5">
        {notCovered
          ? "After checking your recovery manifest, this message’s key was not covered. Forward secrecy may have deleted it before backup, so Ohiyo cannot recreate it later."
          : restoredButFailed
            ? "A recovery backup was restored, but this specific message still could not be read. The key may be incomplete, from a different device state, or already deleted by forward secrecy before backup."
            : "If you made a recovery backup, open Personal recovery to check it. If the key was never backed up, forward secrecy means Ohiyo cannot recreate it later."}
      </p>
      {!restoredButFailed && !notCovered && onOpenRecovery && (
        <button type="button" onClick={onOpenRecovery} className="kc-interactive mt-2 rounded-full px-3 py-1.5 text-xs font-bold" style={{ background: "var(--accent)", color: "#fff", border: "none" }}>
          Open recovery
        </button>
      )}
      {/* No retry button in terminal states: forward-secrecy-deleted keys are
          unrecoverable by construction. A retry affordance here would train users to
          mash a button that can only fail, turning a privacy guarantee into a bug. */}
    </div>
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

// Bounded LRU for link-preview lookups (a long-lived session can otherwise visit
// thousands of URLs and grow this Map unbounded). Map preserves insertion order, so
// the first key is the least-recently-used; touching a key re-inserts it as newest.
const OG_CACHE_MAX = 500;
const ogCache = new Map<string, OgData | null>();
function ogCacheGet(url: string): OgData | null | undefined {
  if (!ogCache.has(url)) return undefined;
  const value = ogCache.get(url);
  ogCache.delete(url);
  ogCache.set(url, value as OgData | null); // mark most-recently-used
  return value;
}
function ogCacheSet(url: string, value: OgData | null): void {
  if (ogCache.has(url)) ogCache.delete(url);
  ogCache.set(url, value);
  while (ogCache.size > OG_CACHE_MAX) {
    const oldest = ogCache.keys().next().value;
    if (oldest === undefined) break;
    ogCache.delete(oldest);
  }
}

function useOgPreview(url: string): OgData | null {
  const token = useContext(OgAuthTokenContext);
  const [data, setData] = useState<OgData | null>(() => ogCacheGet(url) ?? null);
  useEffect(() => {
    // Skip only when we already have real data — a cached null means "retry later".
    if (ogCacheGet(url) != null) return;
    const controller = new AbortController();
    fetch(`${getApiBase()}/og?url=${encodeURIComponent(url)}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      signal: controller.signal,
    })
      .then((r) => (r.ok ? (r.json() as Promise<OgData>) : Promise.reject(new Error("og failed"))))
      .then((d) => {
        ogCacheSet(url, d);
        setData(d);
      })
      .catch((e) => {
        if (e.name !== "AbortError") ogCacheSet(url, null);
      });
    return () => controller.abort();
  }, [url, token]);
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
    // Defense-in-depth: the regex anchors on https?:// but re-validate the scheme
    // before it reaches href so odd inputs can't open-redirect.
    const safeUrl = safeHttpUrl(url);
    if (safeUrl) urls.push(safeUrl);
    segments.push(
      safeUrl ? (
        <a
          key={match.index}
          href={safeUrl}
          target="_blank"
          rel="noopener noreferrer"
          style={{ color: "var(--accent)", textDecoration: "underline" }}
          onClick={(e) => e.stopPropagation()}
        >
          {url}
        </a>
      ) : (
        <span key={match.index}>{url}</span>
      )
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

// ── Composer emoji/GIF picker ────────────────────────────────────────────────

function ComposerMediaPicker({
  tab,
  onTab,
  emojiQuery,
  onEmojiQuery,
  serverEmojis,
  onPickEmoji,
  onPickCustomEmoji,
  gifQuery,
  onGifQuery,
  gifResults,
  gifLoading,
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
  gifQuery: string;
  onGifQuery: (q: string) => void;
  gifResults: GifResult[];
  gifLoading: boolean;
  gifUrl: string;
  onGifUrl: (url: string) => void;
  onSendGif: (url: string) => void;
}) {
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
          <button type="button" onClick={() => onTab("emoji")} style={pill(tab === "emoji")}>Emoji</button>
          <button type="button" onClick={() => onTab("gif")} style={pill(tab === "gif")}>GIFs</button>
        </div>
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>
          {tab === "emoji" ? "Unicode + server emoji" : "Powered by Tenor · paste links too"}
        </div>
      </div>

      {tab === "emoji" ? (
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
              placeholder="Search GIFs…"
              className="kc-field min-w-0 flex-1 px-3 py-2 text-sm outline-none"
            />
            <button type="button" onClick={() => onGifQuery(gifQuery || "excited")} className="kc-cta px-3 py-2 text-sm">Search</button>
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
              No GIFs loaded. Try another search or paste a GIF link.
            </div>
          )}
        </div>
      )}
    </div>
  );
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

function assetUrl(url: string): string {
  // Only http(s) absolute URLs pass through; data:/blob: are rejected so a
  // crafted attachment URL can't smuggle an inline payload into <img>/<video>.
  if (/^https?:/i.test(url)) return url;
  return `${getFileBase()}${url.startsWith("/") ? url : `/${url}`}`;
}

function PendingAttachmentPreview({ file, onRemove }: { file: UploadedFile; onRemove: () => void }) {
  const url = file.previewUrl ?? assetUrl(file.url ?? `/files/${file.id}`);
  const isImage = file.content_type.startsWith("image/");
  const isVideo = file.content_type.startsWith("video/");
  const d = isImage && file.width && file.height ? fitImg(file.width, file.height, 180, 120) : null;
  return (
    <div
      className="relative overflow-hidden rounded-xl border text-xs"
      style={{ background: "var(--bg-input)", borderColor: "var(--bg-hover)", color: "var(--text-secondary)", width: isImage || isVideo ? 190 : undefined }}
    >
      {isImage ? (
        <img
          src={url}
          alt={file.filename}
          className="block w-full object-cover"
          style={{ height: d?.h ?? 110, maxHeight: 120 }}
        />
      ) : isVideo ? (
        <video src={url} muted playsInline preload="metadata" className="block h-[110px] w-full object-cover" />
      ) : null}
      <div className="flex items-center gap-1 px-2 py-1.5">
        <span>{fileIcon(file.content_type)}</span>
        <span className="min-w-0 flex-1 truncate">{file.filename}</span>
        <span style={{ color: "var(--text-muted)" }}>{formatBytes(file.size_bytes)}</span>
      </div>
      {file.encrypted && <AttachmentTrustBadge text="Will encrypt before upload" />}
      <button
        type="button"
        aria-label={`Remove ${file.filename}`}
        onClick={onRemove}
        className="kc-interactive absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full"
        style={{ color: "#fff", background: "rgba(0,0,0,.55)", border: "none", cursor: "pointer" }}
      >
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  );
}

function AttachmentTrustBadge({ text = "Encrypted before upload" }: { text?: string }) {
  return <div className="kc-attachment-trust"><span aria-hidden="true">🔒</span>{text}</div>;
}

function AttachmentList({ attachments }: { attachments: AttachmentMeta[] }) {
  if (!attachments.length) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-2">
      {attachments.map((att) => {
        if (isEncryptedAttachment(att)) return <EncryptedAttachmentItem key={att.id} att={att} />;
        const url = assetUrl(att.url ?? `/files/${att.id}`);
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
                playsInline
                preload="none"
                style={{ width: "min(360px, 100%)", maxHeight: 240, borderRadius: 10, display: "block", background: "var(--bg-input)", objectFit: "contain" }}
              />
              <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                {att.filename} · {formatBytes(att.size_bytes)} · loads only when played
                {" · "}<a href={url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--accent)" }}>Open</a>
              </div>
            </div>
          );
        }
        if (att.content_type.startsWith("audio/")) {
          return (
            <div key={att.id}>
              <audio src={url} controls preload="none" style={{ maxWidth: 300 }} />
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

function EncryptedAttachmentItem({ att }: { att: EncryptedAttachmentMeta }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | null = null;
    const source = assetUrl(att.url ?? `/files/${att.id}`);
    fetch(source)
      .then((r) => {
        if (!r.ok) throw new Error("download failed");
        return r.arrayBuffer();
      })
      .then((bytes) => decryptAttachmentBytes(att, bytes))
      .then((blob) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [att]);

  if (error) {
    return (
      <div className="link-preview" style={{ padding: "6px 10px", color: "var(--danger)" }}>
        🔒 Couldn&apos;t decrypt {att.filename}
      </div>
    );
  }
  if (!url) {
    return (
      <div className="link-preview" style={{ padding: "6px 10px", color: "var(--text-muted)" }}>
        🔒 Decrypting {att.filename}…
      </div>
    );
  }
  if (att.content_type.startsWith("image/")) {
    const d = att.width && att.height ? fitImg(att.width, att.height, 400, 300) : null;
    return (
      <a href={url} download={att.filename} style={{ display: "block" }}>
        <div className="kc-img-frame" style={d ? { width: d.w, height: d.h } : { maxWidth: 400 }}>
          <img className="kc-img" src={url} alt={att.filename} loading="lazy" width={d?.w} height={d?.h} style={d ? undefined : { maxWidth: 400, maxHeight: 300 }} />
        </div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{att.filename} · {formatBytes(att.size_bytes)}</div>
        <AttachmentTrustBadge />
      </a>
    );
  }
  if (att.content_type.startsWith("video/")) {
    return (
      <div>
        <video src={url} controls playsInline preload="none" style={{ width: "min(360px, 100%)", maxHeight: 240, borderRadius: 10, display: "block", background: "var(--bg-input)", objectFit: "contain" }} />
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{att.filename} · {formatBytes(att.size_bytes)}</div>
        <AttachmentTrustBadge />
      </div>
    );
  }
  if (att.content_type.startsWith("audio/")) {
    return (
      <div>
        <audio src={url} controls preload="none" style={{ maxWidth: 300 }} />
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{att.filename} · {formatBytes(att.size_bytes)}</div>
        <AttachmentTrustBadge />
      </div>
    );
  }
  return (
    <div>
      <a href={url} download={att.filename} className="link-preview" style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 4, background: "var(--bg-input)", fontSize: 12, color: "var(--accent)", textDecoration: "none" }}>
        {fileIcon(att.content_type)} {att.filename}
        <span style={{ color: "var(--text-muted)" }}>{formatBytes(att.size_bytes)}</span>
      </a>
      <AttachmentTrustBadge />
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

function HiddenMessageNotice({ authorName, onUndo }: { authorName: string; onUndo: () => void }) {
  return (
    <div
      className="mt-1 inline-flex max-w-full items-center gap-2 rounded-full px-3 py-1.5 text-xs"
      style={{
        background: "color-mix(in oklch, var(--bg-input) 84%, transparent)",
        border: "1px solid color-mix(in oklch, var(--text-primary) 8%, transparent)",
        color: "var(--text-muted)",
      }}
    >
      <span className="truncate">Hidden for you · {authorName}</span>
      <button
        type="button"
        className="kc-interactive font-semibold"
        style={{ color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}
        onClick={(e) => { e.stopPropagation(); onUndo(); }}
      >
        Show
      </button>
    </div>
  );
}

function ActivityNoticeRow({ notice, style }: { notice: ChatActivityNotice; style: React.CSSProperties }) {
  return (
    <div style={style} className="flex items-center justify-center px-4 py-2">
      <div
        className="inline-flex max-w-full items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold"
        style={{
          background: "color-mix(in oklch, var(--accent) 8%, var(--bg-elevated))",
          border: "1px solid color-mix(in oklch, var(--accent) 18%, var(--bg-input))",
          color: "var(--text-secondary)",
        }}
      >
        {notice.user && (
          <span
            className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full text-[9px] font-bold"
            style={{
              background: avatarBg(notice.user.id),
              backgroundImage: notice.user.avatar_url ? `url(${assetUrl(notice.user.avatar_url)})` : undefined,
              backgroundSize: "cover",
              backgroundPosition: "center",
              color: "#fff",
            }}
            aria-hidden="true"
          >
            {!notice.user.avatar_url && notice.user.display_name[0]?.toUpperCase()}
          </span>
        )}
        <span className="truncate">{notice.text}</span>
        <span aria-hidden="true" style={{ color: "var(--text-muted)" }}>·</span>
        <time dateTime={new Date(notice.createdAt).toISOString()} style={{ color: "var(--text-muted)" }}>
          now
        </time>
      </div>
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
