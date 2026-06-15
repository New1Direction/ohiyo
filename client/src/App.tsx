import "./index.css";
import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { api } from "./api";
import { Gateway } from "./gateway";
import { AuthScreen } from "./components/AuthScreen";
import { ServerSidebar } from "./components/ServerSidebar";
import { ChannelSidebar } from "./components/ChannelSidebar";
import { ChatPane } from "./components/ChatPane";
import { ToastStack } from "./components/ToastStack";
import { SettingsModal } from "./components/settings/SettingsModal";
import { CommandPalette } from "./components/CommandPalette";
import { CallOverlay } from "./components/CallOverlay";
import { BootSplash } from "./components/BootSplash";
import { Onboarding } from "./components/Onboarding";
import { CreateServerModal } from "./components/CreateServerModal";
import { InviteAccept } from "./components/InviteAccept";
import { InviteModal } from "./components/InviteModal";
import { FindPeopleModal } from "./components/FindPeopleModal";
import { SearchModal } from "./components/SearchModal";
import { MembersModal } from "./components/MembersModal";
import { RolesModal } from "./components/RolesModal";
import { EventsModal } from "./components/EventsModal";
import { SavedModal } from "./components/SavedModal";
import { CategoriesModal } from "./components/CategoriesModal";
import { ForwardModal } from "./components/ForwardModal";
import { PERM, can } from "./permissions";
import { mentionsUser } from "./lib/mentions";
import { notify, ensureNotificationPermission, initDeepLinks } from "./lib/desktop";
import { addToOutbox, removeFromOutbox, setOutboxState, outboxForChannel, pendingFailedOutbox, reconcileStalePending } from "./lib/outbox";
import { useWebRTC } from "./hooks/useWebRTC";
import type { UseWebRTCReturn } from "./hooks/useWebRTC";
import { useTyping } from "./hooks/useTyping";
import { PluginManager } from "./plugins/registry";
import { applyTheme, loadTheme } from "./themes";
import { useToast } from "./hooks/useToast";
import type { Channel, Message, PublicUser, ServerWithChannels, ServerEmoji } from "./api";
import type { PluginAPI } from "./plugins/api";
import type { GatewayEvent, ConnectionStatus, Activity, WatchSession } from "./gateway";


// Boot the theme from localStorage immediately.
applyTheme(loadTheme());

export default function App() {
  const [token, setToken] = useState<string | null>(
    () => localStorage.getItem("token")
  );

  // Persist the token so sessions survive a reload (single source of truth).
  function handleAuth(newToken: string) {
    localStorage.setItem("token", newToken);
    setToken(newToken);
  }

  if (!token) return <AuthScreen onAuth={handleAuth} />;
  return (
    <MainApp
      token={token}
      onLogout={() => {
        localStorage.removeItem("token");
        setToken(null);
      }}
    />
  );
}

function MainApp({ token, onLogout }: { token: string; onLogout: () => void }) {
  const { toasts, push: toast } = useToast();
  const [currentUser, setCurrentUser] = useState<PublicUser | null>(null);
  const [servers, setServers] = useState<ServerWithChannels[]>([]);
  const [dms, setDms] = useState<Channel[]>([]);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [serverEmojis, setServerEmojis] = useState<ServerEmoji[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showCreateServer, setShowCreateServer] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [showFindPeople, setShowFindPeople] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showRoles, setShowRoles] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [showCategories, setShowCategories] = useState(false);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [eventsRefresh, setEventsRefresh] = useState(0);
  const [myPerms, setMyPerms] = useState(0);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [dmUsers, setDmUsers] = useState<Record<string, PublicUser>>({});
  const [inviteCode, setInviteCode] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("invite")
  );
  const [welcomed, setWelcomed] = useState(
    () => localStorage.getItem("kc:welcomed") === "1"
  );
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [mentions, setMentions] = useState<Set<string>>(new Set());
  // Read receipts: channelId → (userId → last_read_at watermark). Drives the
  // Delivered/Seen indicator in DMs.
  const [receipts, setReceipts] = useState<Record<string, Record<string, number>>>({});
  const [myStatus, setMyStatus] = useState<string | null>(null);
  const typing = useTyping(currentUser?.id ?? "");
  const [connStatus, setConnStatus] = useState<ConnectionStatus>("connecting");

  // Desktop deep links: opening kikkacord://invite/<code> (cold start or while
  // running) routes into the join screen. No-op in the browser.
  useEffect(() => {
    let cleanup = () => {};
    void initDeepLinks((code) => setInviteCode(code)).then((fn) => {
      cleanup = fn;
    });
    return () => cleanup();
  }, []);
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());
  const [activities, setActivities] = useState<Map<string, Activity>>(new Map());
  const [watchSession, setWatchSession] = useState<WatchSession | null>(null);
  const selectedChannelRef = useRef<Channel | null>(null);
  const selectedServerIdRef = useRef<string | null>(null);
  // Last message id we've acked per channel — dedupes redundant read receipts.
  const lastAckRef = useRef<Record<string, string>>({});
  const didAutoSelectRef = useRef(false);
  const notifyAskedRef = useRef(false);
  const handleSelectChannelRef = useRef<(channel: Channel) => void>(() => {});
  const currentUserRef = useRef<PublicUser | null>(null);
  const serversRef = useRef<ServerWithChannels[]>([]);
  const gatewayRef = useRef<Gateway | null>(null);

  /** Set or clear my rich-presence activity; the server echoes it back to update UI. */
  function updateActivity(activity: Activity | null) {
    gatewayRef.current?.send({ t: "SetActivity", d: { activity } });
  }

  /** Drive the watch party in the current channel (set/play/pause/seek/stop). */
  function sendWatchControl(action: string, payload?: { url?: string; position?: number }) {
    const cid = selectedChannelRef.current?.id;
    if (!cid) return;
    gatewayRef.current?.send({
      t: "WatchControl",
      d: { channel_id: cid, action, url: payload?.url ?? null, position: payload?.position ?? null },
    });
  }
  const webrtcRef = useRef<UseWebRTCReturn | null>(null);
  const activeVoiceRef = useRef<string | null>(null);

  // WebRTC mesh call engine — gateway-agnostic; signaling flows through the gateway.
  const webrtc = useWebRTC({
    currentUserId: currentUser?.id ?? "",
    getIceServers: async () => (await api.getIceServers(token)).iceServers,
    sendJoin: (cid, muted, video) =>
      gatewayRef.current?.send({ t: "JoinVoice", d: { channel_id: cid, muted, video } }),
    sendLeave: (cid) => gatewayRef.current?.send({ t: "LeaveVoice", d: { channel_id: cid } }),
    sendMeta: (cid, muted, video, screen) =>
      gatewayRef.current?.send({ t: "VoiceMeta", d: { channel_id: cid, muted, video, screen } }),
    sendSignal: (to, kind, payload) =>
      gatewayRef.current?.send({
        t: "Signal",
        d: { to, channel_id: activeVoiceRef.current ?? "", kind, payload },
      }),
  });
  // Keep refs in sync after commit (concurrent-safe — no ref writes during render).
  useLayoutEffect(() => {
    webrtcRef.current = webrtc;
    activeVoiceRef.current = webrtc.channelId;
    // Keep the gateway handler's view of channel selection current (avoids a
    // stale closure: handleGatewayEvent is registered once per token).
    handleSelectChannelRef.current = handleSelectChannel;
  });

  useEffect(() => { selectedChannelRef.current = selectedChannel; }, [selectedChannel]);
  useEffect(() => {
    currentUserRef.current = currentUser;
    window.__kikkacordUser = currentUser;
  }, [currentUser]);

  // Load our saved custom status once we're known.
  useEffect(() => {
    if (!currentUser) return;
    let alive = true;
    api.getMyProfile(token)
      .then((p) => alive && setMyStatus(p.custom_status ?? null))
      .catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on the user identity (id), not every currentUser object change
  }, [currentUser?.id, token]);

  // Reflect total unread in the tab title so it's visible when backgrounded.
  useEffect(() => {
    const total = Object.values(unread).reduce((sum, n) => sum + n, 0);
    document.title = total > 0 ? `(${total}) Kikkacord` : "Kikkacord";
  }, [unread]);

  // My effective permissions for the selected server (gates moderation UI).
  useEffect(() => {
    selectedServerIdRef.current = selectedServerId;
    if (!selectedServerId) { setMyPerms(0); return; }
    let alive = true;
    api.getMyPermissions(token, selectedServerId)
      .then((p) => alive && setMyPerms(p.permissions))
      .catch(() => alive && setMyPerms(0));
    return () => { alive = false; };
  }, [selectedServerId, token]);
  useEffect(() => { serversRef.current = servers; }, [servers]);

  // Build plugin API (stable ref).
  const pluginApiRef = useRef<PluginAPI>({
    getUser: () => currentUserRef.current,
    getServers: () => serversRef.current,
    getCurrentChannel: () => selectedChannelRef.current,
    getMessages: () => [],
    store: { get: (_key: string) => null, set: () => {}, del: () => {} },
    toast,
    on: () => () => {},
  });

  // Plugin manager (created once).
  const pluginManagerRef = useRef<PluginManager>(
    new PluginManager(pluginApiRef.current)
  );

  useEffect(() => {
    pluginManagerRef.current.loadEnabled();
  }, []);

  // Gateway connection.
  useEffect(() => {
    const gw = new Gateway(token);
    gatewayRef.current = gw;
    const unsub = gw.on(handleGatewayEvent);
    const unsubStatus = gw.onStatus(setConnStatus);
    gw.connect();
    return () => { unsub(); unsubStatus(); gw.disconnect(); gatewayRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- (re)connect only when the token changes; handleGatewayEvent reads latest state via refs, so the closure here is intentional
  }, [token]);

  function handleGatewayEvent(event: GatewayEvent) {
    switch (event.t) {
      case "Ready":
        setCurrentUser(event.d.user);
        setServers(event.d.servers);
        setDms(event.d.dms);
        // Smooth landing: on first connect, drop into a real channel rather than
        // a "pick one" screen. Runs once so reconnects never yank you around.
        if (!didAutoSelectRef.current && !selectedChannelRef.current) {
          didAutoSelectRef.current = true;
          const firstServer = event.d.servers[0];
          const firstText = firstServer?.channels.find((c) => c.channel_type === "text");
          if (firstServer && firstText) {
            setSelectedServerId(firstServer.id);
            handleSelectChannelRef.current(firstText);
          }
        }
        pluginManagerRef.current.emit("ready", event.d);
        break;

      case "MessageCreate": {
        const msg = event.d;
        typing.clearTyping(msg.channel_id, msg.author.id);
        if (selectedChannelRef.current?.id === msg.channel_id) {
          setMessages((prev) => [...prev, msg]);
          // You're looking at this channel → it's read. Advance the cursor.
          sendAck(msg.channel_id, msg.id);
        } else if (currentUserRef.current && msg.author.id !== currentUserRef.current.id) {
          // New message in a channel you're not looking at → bump its unread count.
          // Guarded on currentUser so a pre-Ready event can't mis-count our own.
          setUnread((prev) => ({ ...prev, [msg.channel_id]: (prev[msg.channel_id] ?? 0) + 1 }));
        }
        // A message that @-mentions you in another channel gets a stronger badge.
        if (
          currentUserRef.current &&
          msg.author.id !== currentUserRef.current.id &&
          selectedChannelRef.current?.id !== msg.channel_id &&
          mentionsUser(msg.content, currentUserRef.current.username)
        ) {
          setMentions((prev) => {
            const next = new Set(prev);
            next.add(msg.channel_id);
            return next;
          });
        }
        maybeNotify(msg);
        pluginManagerRef.current.emit("message", msg);
        break;
      }

      case "MessageUpdate": {
        const msg = event.d;
        setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
        break;
      }

      case "MessageDelete":
        setMessages((prev) => prev.filter((m) => m.id !== event.d.id));
        break;

      case "ServerCreate":
        // Upsert: also used as a "server changed" signal (categories, channel moves).
        setServers((prev) =>
          prev.some((s) => s.id === event.d.id)
            ? prev.map((s) => (s.id === event.d.id ? event.d : s))
            : [...prev, event.d]
        );
        break;

      case "ServerDelete":
        setServers((prev) => prev.filter((s) => s.id !== event.d.id));
        break;

      case "ChannelCreate":
        setServers((prev) =>
          prev.map((s) =>
            s.id === event.d.server_id
              ? { ...s, channels: [...s.channels, event.d] }
              : s
          )
        );
        break;

      case "MemberJoin": {
        const { server_id, user } = event.d;
        setServers((prev) =>
          prev.map((s) =>
            s.id === server_id && !s.members.find((m) => m.id === user.id)
              ? { ...s, members: [...s.members, user] }
              : s
          )
        );
        break;
      }

      case "MemberLeave": {
        const { server_id, user_id } = event.d;
        if (user_id === currentUserRef.current?.id) {
          // We left or were removed — drop the server and leave its channel if open.
          setServers((prev) => prev.filter((s) => s.id !== server_id));
          if (selectedChannelRef.current?.server_id === server_id) {
            setSelectedChannel(null);
            selectedChannelRef.current = null;
            setMessages([]);
          }
          setSelectedServerId((cur) => (cur === server_id ? null : cur));
          setShowSearch(false);
          setShowMembers(false);
        } else {
          setServers((prev) =>
            prev.map((s) =>
              s.id === server_id
                ? { ...s, members: s.members.filter((m) => m.id !== user_id) }
                : s
            )
          );
        }
        break;
      }

      case "ReactionUpdate": {
        const { message_id, emoji, user_id, added } = event.d;
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== message_id) return m;
            const reactions = m.reactions ?? [];
            const existing = reactions.find((r) => r.emoji === emoji);
            const isMe = user_id === currentUserRef.current?.id;
            if (existing) {
              const newCount = added ? existing.count + 1 : existing.count - 1;
              if (newCount <= 0) {
                return { ...m, reactions: reactions.filter((r) => r.emoji !== emoji) };
              }
              return {
                ...m,
                reactions: reactions.map((r) =>
                  r.emoji === emoji
                    ? { ...r, count: newCount, me: isMe ? added : r.me }
                    : r
                ),
              };
            } else if (added) {
              return { ...m, reactions: [...reactions, { emoji, count: 1, me: isMe }] };
            }
            return m;
          })
        );
        break;
      }

      case "ReadReceipt": {
        const { channel_id, user_id, last_read_at } = event.d;
        setReceipts((prev) => {
          const chan = prev[channel_id] ?? {};
          if ((chan[user_id] ?? 0) >= last_read_at) return prev; // monotonic — never rewind
          return { ...prev, [channel_id]: { ...chan, [user_id]: last_read_at } };
        });
        break;
      }

      case "PresenceUpdate": {
        const { user_id, online, activity } = event.d;
        setOnlineUsers((prev) => {
          const next = new Set(prev);
          if (online) next.add(user_id);
          else next.delete(user_id);
          return next;
        });
        setActivities((prev) => {
          const next = new Map(prev);
          if (online && activity) next.set(user_id, activity);
          else next.delete(user_id);
          return next;
        });
        break;
      }

      case "WatchUpdate": {
        if (event.d.channel_id === selectedChannelRef.current?.id) {
          setWatchSession(event.d.session);
        }
        break;
      }

      case "TypingStart":
        // Filter our own echo via the always-current ref (handler is registered once).
        if (event.d.user_id !== currentUserRef.current?.id) {
          typing.onTypingStart(event.d.channel_id, event.d.user);
        }
        break;

      case "PermissionsUpdate":
        // Our roles changed — refresh effective permissions live, no reload needed.
        if (event.d.server_id === selectedServerIdRef.current) {
          api.getMyPermissions(token, event.d.server_id)
            .then((p) => setMyPerms(p.permissions))
            .catch(() => {});
        }
        break;

      case "EventsChanged":
        // Someone added/RSVP'd/removed an event — nudge an open Events panel to refetch.
        if (event.d.server_id === selectedServerIdRef.current) {
          setEventsRefresh((n) => n + 1);
        }
        break;

      case "VoiceRoster":
        webrtcRef.current?.onRoster(event.d.channel_id, event.d.peers);
        break;

      case "VoiceSignal":
        void webrtcRef.current?.onPeerSignal(event.d);
        break;

      case "VoiceState":
        webrtcRef.current?.onVoiceState(event.d);
        break;
    }
  }

  // Keyboard shortcut: Ctrl+, opens settings; Alt+N jumps to server N.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey && e.key === ",") {
        e.preventDefault();
        setShowSettings((s) => !s);
      }
    }
    function onOpenSearch() {
      setShowCommandPalette(true);
    }
    function onJumpServer(e: Event) {
      const idx = (e as CustomEvent<number>).detail;
      const server = serversRef.current[idx];
      if (server) {
        setSelectedServerId(server.id);
        setSelectedChannel(null);
        setMessages([]);
      }
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("kikkacord:jump-server", onJumpServer);
    window.addEventListener("kikkacord:open-search", onOpenSearch);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("kikkacord:jump-server", onJumpServer);
      window.removeEventListener("kikkacord:open-search", onOpenSearch);
    };
  }, []);

  // ── Read receipts ───────────────────────────────────────────────────────────
  // Mark a channel read up to `messageId`: advances the server-side read cursor,
  // and for DMs the server fans out a ReadReceipt so the sender sees "Seen".
  // Deduped per channel, and only recorded on a successful socket send so a
  // closed socket retries on the next trigger.
  function sendAck(channelId: string, messageId: string | undefined) {
    if (!messageId || messageId.startsWith("temp-")) return;
    if (lastAckRef.current[channelId] === messageId) return;
    const ok = gatewayRef.current?.send({ t: "Ack", d: { channel_id: channelId, message_id: messageId } });
    if (ok) lastAckRef.current[channelId] = messageId;
  }

  /** Newest non-optimistic message id in a list — the read watermark. */
  function lastRealMessageId(msgs: Message[]): string | undefined {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (!msgs[i].id.startsWith("temp-")) return msgs[i].id;
    }
    return undefined;
  }

  async function handleSelectChannel(channel: Channel) {
    setSelectedChannel(channel);
    selectedChannelRef.current = channel;
    setMobileNavOpen(false); // collapse the drawer once you've picked a channel
    // Reset + fetch the watch-party state for the channel we're entering.
    setWatchSession(null);
    api.getWatch(token, channel.id)
      .then((s) => { if (selectedChannelRef.current?.id === channel.id) setWatchSession(s); })
      .catch(() => {});
    // Opening a channel marks it read (and clears any mention).
    setUnread((prev) => {
      if (!prev[channel.id]) return prev;
      const next = { ...prev };
      delete next[channel.id];
      return next;
    });
    setMentions((prev) => {
      if (!prev.has(channel.id)) return prev;
      const next = new Set(prev);
      next.delete(channel.id);
      return next;
    });
    setIsLoadingMessages(true);
    pluginManagerRef.current.emit("channel-select", channel);
    // Fetch emojis for the server this channel belongs to
    if (channel.server_id) {
      api.listEmojis(token, channel.server_id)
        .then(setServerEmojis)
        .catch((e) => console.warn("[kikkacord] couldn't load server emoji", e));
    } else {
      setServerEmojis([]);
    }
    try {
      const msgs = await api.listMessages(token, channel.id);
      // Ignore a stale load if the user switched channels while this was in flight.
      if (selectedChannelRef.current?.id !== channel.id) return;
      // Re-attach any unsent/failed messages queued for this channel.
      const queued = outboxForChannel(channel.id);
      setMessages(queued.length ? [...msgs, ...queued] : msgs);
      // Opening the channel marks it read on the server (drives the read cursor).
      sendAck(channel.id, lastRealMessageId(msgs));
      // For DMs, hydrate existing Delivered/Seen state; live updates then arrive
      // via the ReadReceipt gateway event.
      if (!channel.server_id) {
        api.listReads(token, channel.id)
          .then((cursors) => {
            if (selectedChannelRef.current?.id !== channel.id) return;
            setReceipts((prev) => ({
              ...prev,
              [channel.id]: Object.fromEntries(cursors.map((c) => [c.user_id, c.last_read_at])),
            }));
          })
          .catch(() => {});
      }
    } catch {
      if (selectedChannelRef.current?.id !== channel.id) return;
      // Even offline, show the queued outbox so drafts-in-flight aren't lost.
      setMessages(outboxForChannel(channel.id));
    } finally {
      if (selectedChannelRef.current?.id === channel.id) setIsLoadingMessages(false);
    }
  }

  const handleSend = useCallback(
    async (content: string, attachmentIds?: string[], replyTo?: string | null) => {
      if (!selectedChannelRef.current) return;
      // Ask for notification permission on the first send — a clear user gesture.
      // Works for both native (Tauri) and web notifications.
      if (!notifyAskedRef.current) {
        notifyAskedRef.current = true;
        void ensureNotificationPermission();
      }
      // Optimistic add — removed when gateway echo arrives.
      const tempId = `temp-${Date.now()}`;
      const me = currentUserRef.current;
      if (me && (content || attachmentIds?.length)) {
        const optimistic: Message = {
          id: tempId,
          channel_id: selectedChannelRef.current!.id,
          author: me,
          content,
          created_at: Math.floor(Date.now() / 1000),
          edited_at: null,
          attachments: null,
          reactions: [],
          _state: "pending",
          _send: { content, attachmentIds, replyTo },
        };
        setMessages((prev) => [...prev, optimistic]);
        addToOutbox(optimistic); // persisted so it survives a switch/reload/offline
      }
      try {
        await api.sendMessage(token, selectedChannelRef.current!.id, content, attachmentIds, replyTo);
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
        removeFromOutbox(tempId);
      } catch {
        // Keep the message visible in a failed state (persisted) so it can be retried.
        setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, _state: "failed" } : m)));
        setOutboxState(tempId, "failed");
      }
    },
    [token]
  );

  // Retry a failed/queued message using its stored send args.
  const handleRetryMessage = useCallback(
    async (msg: Message) => {
      const send = msg._send;
      if (!send) return;
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, _state: "pending" } : m)));
      setOutboxState(msg.id, "pending");
      try {
        await api.sendMessage(token, msg.channel_id, send.content, send.attachmentIds, send.replyTo ?? null);
        setMessages((prev) => prev.filter((m) => m.id !== msg.id));
        removeFromOutbox(msg.id);
      } catch {
        setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, _state: "failed" } : m)));
        setOutboxState(msg.id, "failed");
      }
    },
    [token]
  );

  // Drop a failed message (it never reached the server).
  const handleDiscardFailed = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
    removeFromOutbox(id);
  }, []);

  // Re-send everything still queued in the outbox (called on connectivity return).
  const flushOutbox = useCallback(() => {
    for (const m of pendingFailedOutbox()) void handleRetryMessage(m);
  }, [handleRetryMessage]);

  // On startup, demote stale "pending" (a session that died mid-send) to failed.
  useEffect(() => {
    reconcileStalePending();
  }, []);

  // Flush when the browser regains connectivity or the gateway reconnects.
  useEffect(() => {
    window.addEventListener("online", flushOutbox);
    return () => window.removeEventListener("online", flushOutbox);
  }, [flushOutbox]);
  useEffect(() => {
    if (connStatus === "connected") flushOutbox();
  }, [connStatus, flushOutbox]);

  // ── Message actions (edit / delete / pin) — UI updates arrive via gateway echo.
  async function handleEditMessage(messageId: string, content: string) {
    const cid = selectedChannelRef.current?.id;
    if (!cid) return;
    try {
      await api.editMessage(token, cid, messageId, content);
    } catch (err) {
      toast(`Couldn't edit: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  async function handleDeleteMessage(messageId: string) {
    const cid = selectedChannelRef.current?.id;
    if (!cid) return;
    try {
      await api.deleteMessage(token, cid, messageId);
    } catch (err) {
      toast(`Couldn't delete: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  async function handlePinMessage(messageId: string, pinned: boolean) {
    const cid = selectedChannelRef.current?.id;
    if (!cid) return;
    try {
      await (pinned ? api.pinMessage : api.unpinMessage)(token, cid, messageId);
    } catch (err) {
      toast(`Couldn't ${pinned ? "pin" : "unpin"}: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  // Forward a message (text + attachments) to another channel, with attribution.
  async function handleForward(channelId: string) {
    const m = forwarding;
    setForwarding(null);
    if (!m) return;
    const content = `【FWD:${m.author.display_name}】${m.content}`;
    const attachmentIds = (m.attachments ?? []).map((a) => a.id);
    try {
      await api.sendMessage(token, channelId, content, attachmentIds);
      toast("Forwarded ↪", "success");
    } catch (err) {
      toast(`Couldn't forward: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  // Show a desktop notification for a message you're not actively reading.
  function maybeNotify(msg: Message) {
    if (msg.author.id === currentUserRef.current?.id) return;
    const lookingAtIt =
      selectedChannelRef.current?.id === msg.channel_id && !document.hidden;
    if (lookingAtIt) return;
    const body = msg.content?.slice(0, 140) || "Sent an attachment";
    // Native OS notification under Tauri, Web Notification in a browser.
    void notify({ title: msg.author.display_name, body });
  }

  // Jump to a channel from search results (find it across loaded servers).
  function jumpToChannel(channelId: string) {
    for (const s of serversRef.current) {
      const ch = s.channels.find((c) => c.id === channelId);
      if (ch) {
        setSelectedServerId(s.id);
        void handleSelectChannel(ch);
        return;
      }
    }
  }

  // Owner removes a member from the current server. UI updates via MemberLeave.
  async function handleKick(userId: string) {
    if (!selectedServerId) return;
    try {
      await api.kickMember(token, selectedServerId, userId);
      toast("Member removed", "success");
    } catch (err) {
      toast(`Couldn't remove: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  // Owner bans a member — removed and blocked from rejoining.
  async function handleBan(userId: string) {
    if (!selectedServerId) return;
    try {
      await api.banMember(token, selectedServerId, userId);
      toast("Member banned", "success");
    } catch (err) {
      toast(`Couldn't ban: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  // Notify the channel that we're typing (ChatPane throttles the calls).
  function sendTyping() {
    if (selectedChannelRef.current) {
      gatewayRef.current?.send({ t: "Typing", d: { channel_id: selectedChannelRef.current.id } });
    }
  }

  // Set a custom status ("vibe"), persisted to the profile.
  async function handleSetStatus(status: string) {
    const trimmed = status.trim();
    try {
      await api.updateProfile(token, { custom_status: trimmed });
      setMyStatus(trimmed || null);
    } catch (err) {
      toast(`Couldn't update status: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  function markWelcomed() {
    setWelcomed(true);
    localStorage.setItem("kc:welcomed", "1");
  }

  // Add a server to state and drop the user straight into a live channel —
  // shared by create, invite-redeem, and onboarding so there's never an empty room.
  function enterServer(server: ServerWithChannels) {
    setServers((prev) => [...prev.filter((s) => s.id !== server.id), server]);
    setSelectedServerId(server.id);
    setSelectedChannel(null);
    markWelcomed();
    const firstText =
      server.channels.find((c) => c.channel_type === "text") ?? server.channels[0] ?? null;
    if (firstText) void handleSelectChannel(firstText);
  }

  // Create-a-server path, shared by onboarding and the "+" modal.
  // Throws on failure so the caller's form can surface the message inline.
  async function createServerAndEnter(name: string) {
    const server = await api.createServer(token, name);
    enterServer(server);
    toast(`Welcome to ${server.name}! 🎉`, "success");
  }

  // ── Invite redemption ───────────────────────────────────────────────────────
  function clearInviteParam() {
    const url = new URL(window.location.href);
    url.searchParams.delete("invite");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    setInviteCode(null);
  }

  function handleInviteJoin(server: ServerWithChannels) {
    enterServer(server);
    clearInviteParam();
    toast(`You're in — welcome to ${server.name}! 🎉`, "success");
  }

  // ── Direct messages ─────────────────────────────────────────────────────────
  async function openDmWith(user: PublicUser) {
    try {
      const channel = await api.openDm(token, user.id);
      setDms((prev) => (prev.find((d) => d.id === channel.id) ? prev : [channel, ...prev]));
      setDmUsers((prev) => ({ ...prev, [channel.id]: user }));
      setSelectedServerId(null);
      setShowFindPeople(false);
      void handleSelectChannel(channel);
    } catch (err) {
      toast(`Couldn't open that chat: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  async function handleCreateChannel(name: string) {
    if (!selectedServerId) return;
    try {
      await api.createChannel(token, selectedServerId, name);
      toast(`Channel #${name} created`, "success");
    } catch (err) {
      toast(`Failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  function handleJoinVoice(channel: Channel) {
    setMobileNavOpen(false);
    if (webrtc.channelId === channel.id) return;
    webrtc.joinVoice(channel.id, { video: false }).catch((err) =>
      toast(`Couldn't join the call: ${err instanceof Error ? err.message : err}`, "error")
    );
  }

  // ⚠️ All hooks must be declared ABOVE this line — the early returns below are
  // conditional, so any hook placed after them would violate the Rules of Hooks.

  // Until the first `Ready` payload lands, show a warm splash instead of empty chrome.
  if (!currentUser) {
    return <BootSplash connStatus={connStatus} onLogout={onLogout} />;
  }

  // Arrived via an invite link → show the join screen before anything else.
  if (inviteCode) {
    return (
      <InviteAccept
        token={token}
        code={inviteCode}
        onJoin={handleInviteJoin}
        onDismiss={clearInviteParam}
      />
    );
  }

  // First run (or no servers yet) → a welcome that turns into one obvious action.
  if (servers.length === 0 && !welcomed) {
    return (
      <Onboarding
        displayName={currentUser.display_name}
        onCreate={createServerAndEnter}
        onSkip={markWelcomed}
      />
    );
  }

  const selectedServer = servers.find((s) => s.id === selectedServerId) ?? null;
  const voiceChannel =
    servers.flatMap((s) => s.channels).find((c) => c.id === webrtc.channelId) ?? null;
  // Servers with at least one unread channel get a dot on the rail.
  const unreadServerIds = new Set<string>();
  for (const s of servers) {
    if (s.channels.some((c) => unread[c.id])) unreadServerIds.add(s.id);
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* Server + channel rails — a slide-in drawer on phones, fixed panes on desktop */}
      <div className={`kc-nav${mobileNavOpen ? " is-open" : ""}`}>
        <div className="server-sidebar">
          <ServerSidebar
            servers={servers}
            selectedId={selectedServerId}
            onSelect={(id) => {
              setSelectedServerId(id || null);
              setSelectedChannel(null);
              setMessages([]);
              if (id) pluginManagerRef.current.emit("server-select", id);
            }}
            onCreateServer={() => setShowCreateServer(true)}
            onOpenSettings={() => setShowSettings(true)}
            onOpenSaved={() => setShowSaved(true)}
            unreadServerIds={unreadServerIds}
          />
        </div>

        <div className="channel-sidebar">
          <ChannelSidebar
            server={selectedServer}
            dms={dms}
            dmUsers={dmUsers}
            selectedChannelId={selectedChannel?.id ?? null}
            currentUser={currentUser}
            connStatus={connStatus}
            onlineUsers={onlineUsers}
            activeVoiceChannelId={webrtc.channelId}
            voiceParticipantCount={webrtc.participants.length + (webrtc.channelId ? 1 : 0)}
            unread={unread}
            mentionChannels={mentions}
            myStatus={myStatus}
            onSetStatus={handleSetStatus}
            myActivity={currentUser ? activities.get(currentUser.id) ?? null : null}
            onSetActivity={updateActivity}
            canManageChannels={can(myPerms, PERM.MANAGE_CHANNELS)}
            onOpenCategories={() => setShowCategories(true)}
            onSelectChannel={handleSelectChannel}
            onJoinVoice={handleJoinVoice}
            onCreateChannel={handleCreateChannel}
            onInvite={() => setShowInvite(true)}
            onFindPeople={() => setShowFindPeople(true)}
            onOpenEvents={() => setShowEvents(true)}
            onLogout={onLogout}
            onOpenSettings={() => setShowSettings(true)}
          />
        </div>
      </div>

      {/* Tap-away scrim, only present while the mobile drawer is open */}
      {mobileNavOpen && (
        <div className="kc-nav-scrim" onClick={() => setMobileNavOpen(false)} aria-hidden />
      )}

      <ChatPane
        channel={selectedChannel}
        messages={messages}
        currentUserId={currentUser?.id ?? ""}
        token={token}
        pluginManager={pluginManagerRef.current}
        serverEmojis={serverEmojis}
        onSend={handleSend}
        onRetry={handleRetryMessage}
        onDiscardFailed={handleDiscardFailed}
        onToast={toast}
        isLoading={isLoadingMessages}
        onOpenNav={() => setMobileNavOpen(true)}
        typingUsers={typing.typingIn(selectedChannel?.id ?? "")}
        onTyping={sendTyping}
        onEditMessage={handleEditMessage}
        onDeleteMessage={handleDeleteMessage}
        onPinMessage={handlePinMessage}
        onForward={(msg) => setForwarding(msg)}
        onOpenSearch={selectedServer ? () => setShowSearch(true) : undefined}
        onOpenMembers={selectedServer ? () => setShowMembers(true) : undefined}
        mentionables={selectedServer?.members ?? []}
        currentUsername={currentUser.username}
        receipts={selectedChannel ? receipts[selectedChannel.id] : undefined}
        watchSession={watchSession}
        onWatchControl={sendWatchControl}
      />

      {/* Voice / video / screen-share call overlay */}
      <CallOverlay
        webrtc={webrtc}
        currentUser={currentUser}
        channelName={voiceChannel?.name ?? "Voice"}
      />

      {/* Toast notifications */}
      <ToastStack toasts={toasts} />

      {/* Command palette — Ctrl+K or kikkacord:open-search */}
      {showCommandPalette && (
        <CommandPalette
          servers={servers}
          dms={dms}
          onSelectChannel={handleSelectChannel}
          onClose={() => setShowCommandPalette(false)}
        />
      )}

      {/* Create-a-server modal — replaces the old window.prompt */}
      {showCreateServer && (
        <CreateServerModal
          onCreate={createServerAndEnter}
          onClose={() => setShowCreateServer(false)}
        />
      )}

      {/* Invite-people modal — generates a shareable link for the open server */}
      {showInvite && selectedServer && (
        <InviteModal
          token={token}
          serverId={selectedServer.id}
          serverName={selectedServer.name}
          onClose={() => setShowInvite(false)}
        />
      )}

      {/* Find-people modal — search users and start a DM */}
      {showFindPeople && (
        <FindPeopleModal
          token={token}
          onOpenDm={openDmWith}
          onClose={() => setShowFindPeople(false)}
        />
      )}

      {/* Message search across the current server */}
      {showSearch && selectedServer && (
        <SearchModal
          token={token}
          serverId={selectedServer.id}
          channels={selectedServer.channels}
          onJump={jumpToChannel}
          onClose={() => setShowSearch(false)}
        />
      )}

      {/* Members list + moderation (gated by permissions) */}
      {showMembers && selectedServer && (
        <MembersModal
          members={selectedServer.members}
          ownerId={selectedServer.owner_id}
          currentUserId={currentUser.id}
          onlineUsers={onlineUsers}
          activities={activities}
          canKick={can(myPerms, PERM.KICK_MEMBERS)}
          canBan={can(myPerms, PERM.BAN_MEMBERS)}
          canManageRoles={can(myPerms, PERM.MANAGE_ROLES)}
          onManageRoles={() => { setShowMembers(false); setShowRoles(true); }}
          onKick={handleKick}
          onBan={handleBan}
          onClose={() => setShowMembers(false)}
        />
      )}

      {/* Roles & permissions manager */}
      {showRoles && selectedServer && (
        <RolesModal
          token={token}
          serverId={selectedServer.id}
          members={selectedServer.members}
          ownerId={selectedServer.owner_id}
          onClose={() => setShowRoles(false)}
        />
      )}

      {/* Scheduled events */}
      {showEvents && selectedServer && (
        <EventsModal
          token={token}
          serverId={selectedServer.id}
          currentUserId={currentUser.id}
          refreshKey={eventsRefresh}
          onClose={() => setShowEvents(false)}
        />
      )}

      {/* Saved messages */}
      {showSaved && (
        <SavedModal
          token={token}
          onJump={jumpToChannel}
          onClose={() => setShowSaved(false)}
        />
      )}

      {/* Channel categories */}
      {showCategories && selectedServer && (
        <CategoriesModal
          token={token}
          serverId={selectedServer.id}
          categories={selectedServer.categories ?? []}
          channels={selectedServer.channels}
          onClose={() => setShowCategories(false)}
        />
      )}

      {/* Forward a message to another channel */}
      {forwarding && (
        <ForwardModal
          message={forwarding}
          servers={servers}
          onForward={handleForward}
          onClose={() => setForwarding(null)}
        />
      )}

      {/* Settings modal */}
      {showSettings && (
        <SettingsModal
          currentUser={currentUser}
          pluginManager={pluginManagerRef.current}
          token={token}
          servers={servers}
          onClose={() => setShowSettings(false)}
          onToast={toast}
        />
      )}
    </div>
  );
}
