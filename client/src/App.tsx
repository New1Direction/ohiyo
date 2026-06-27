import "./index.css";
import { useEffect, useLayoutEffect, useRef, useState, useCallback, useSyncExternalStore, type FormEvent } from "react";
import { api, getApiBase, setServerOrigin } from "./api";
import { Gateway } from "./gateway";
import { AuthScreen } from "./components/AuthScreen";
import { ModalShell } from "./components/ModalShell";
import { ServerSidebar } from "./components/ServerSidebar";
import { ChannelSidebar } from "./components/ChannelSidebar";
import { ChatPane, type ChatActivityNotice } from "./components/ChatPane";
import { ToastStack } from "./components/ToastStack";
import { SettingsModal, type Tab } from "./components/settings/SettingsModal";
import { CommandPalette } from "./components/CommandPalette";
import { CallOverlay } from "./components/CallOverlay";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { BootSplash } from "./components/BootSplash";
import { Onboarding } from "./components/Onboarding";
import { NoServersYet } from "./components/NoServersYet";
import { CreateServerModal } from "./components/CreateServerModal";
import { DiscordImportModal } from "./components/DiscordImportModal";
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
import { mentionsYou } from "./lib/mentions";
import { notify, ensureNotificationPermission, initDeepLinks, claimNotification, isDesktop } from "./lib/desktop";
import { addToOutbox, removeFromOutbox, setOutboxState, outboxForChannel, pendingFailedOutbox, reconcileStalePending } from "./lib/outbox";
import { useWebRTC } from "./hooks/useWebRTC";
import { useWebRTCLiveKit } from "./hooks/useWebRTCLiveKit";
import { myKeyPair, deriveSharedKey, decryptMessage, isEncrypted } from "./lib/e2e";
import { initSignal, encryptFor, decryptFrom, isSignalCiphertext, safetyNumber } from "./lib/signal";
import {
  onIdentityChange,
  trustState,
  markVerified,
  acknowledgeIdentityChange,
  type TrustState,
} from "./lib/identityTrust";
import { cachePlaintext, getCachedPlaintext, removeCachedPlaintext } from "./lib/e2eCache";
import {
  groupEncrypt,
  groupDecrypt,
  isGroupCiphertext,
  buildDistribution,
  installDistribution,
  setGroupEpoch,
} from "./lib/senderKeys";
import { formatDuration } from "./lib/disappearing";
import { initVaultBackend } from "./lib/tauriVault";
import type { UseWebRTCReturn, WebRTCCallbacks } from "./hooks/useWebRTC";
import { useTyping } from "./hooks/useTyping";
import { PluginManager } from "./plugins/registry";
import { applyActiveAppearance, setAccent } from "./lib/appearance";
import { pullAppearance, pushAppearance } from "./lib/appearanceSync";
import {
  loadLocalPrivacyPrefs,
  mergePrivacyIntoPrefs,
  readPrivacyPrefs,
  saveLocalPrivacyPrefs,
  type PrivacyPrefs,
} from "./lib/privacyPrefs";
import { useToast } from "./hooks/useToast";
import {
  loadActiveHomeId,
  loadHomes,
  saveActiveHomeId,
  saveHomes,
  setHomeToken,
  upsertHome,
  type OhiyoHome,
} from "./lib/homes";
import type { Channel, Message, PublicUser, ServerWithChannels, ServerEmoji } from "./api";
import type { PluginAPI } from "./plugins/api";
import type { GatewayEvent, ConnectionStatus, Activity, WatchSession } from "./gateway";


// Boot the theme + personal accent from localStorage immediately (warm first paint).
applyActiveAppearance();

export default function App() {
  const initialHomesRef = useRef<OhiyoHome[] | null>(null);
  if (!initialHomesRef.current) initialHomesRef.current = loadHomes();
  const [homes, setHomes] = useState<OhiyoHome[]>(() => initialHomesRef.current ?? loadHomes());
  const [activeHomeId, setActiveHomeIdState] = useState(() =>
    loadActiveHomeId(initialHomesRef.current ?? loadHomes())
  );
  const activeHome = homes.find((h) => h.id === activeHomeId) ?? homes[0];
  const token = activeHome?.token ?? null;
  const [showAddHome, setShowAddHome] = useState(false);
  // Desktop: the session token lives in the encrypted vault, which hydrates
  // asynchronously. Until it's ready we can't tell "logged out" from "token still
  // sealed", so the UI is gated on this flag. Web has no vault → ready immediately.
  const [vaultReady, setVaultReady] = useState(() => !isDesktop());

  useEffect(() => {
    if (activeHome) setServerOrigin(activeHome.url);
  }, [activeHome]);

  // Hydrate the desktop vault once at startup, then re-read homes so each home's token
  // resolves from the now-warm vault (it was absent from the synchronous first load).
  // `.finally` guarantees we never get stuck on the splash if the vault is unavailable.
  useEffect(() => {
    if (!isDesktop()) return; // web: tokens already came from localStorage synchronously
    let cancelled = false;
    void initVaultBackend().finally(() => {
      if (cancelled) return;
      setHomes(loadHomes());
      setVaultReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function persistHomes(next: OhiyoHome[]) {
    setHomes(next);
    saveHomes(next);
  }

  function setActiveHomeId(id: string) {
    setActiveHomeIdState(id);
    saveActiveHomeId(id);
    const home = homes.find((h) => h.id === id);
    if (home) setServerOrigin(home.url);
  }

  function addHome(url: string) {
    const next = upsertHome(homes, { url });
    persistHomes(next);
    setActiveHomeId(next[0].id);
  }

  // Persist the token to the active home so sessions survive reloads per server.
  function handleAuth(newToken: string) {
    if (!activeHome) return;
    persistHomes(setHomeToken(homes, activeHome.id, newToken));
  }

  function handleLogout() {
    if (!activeHome) return;
    persistHomes(setHomeToken(homes, activeHome.id, null));
  }

  if (!activeHome) return null;
  if (!vaultReady) {
    // Desktop only: a brief wait while the encrypted vault unlocks and the session token
    // hydrates, so an already-signed-in user never flashes the login screen.
    return <div className="fixed inset-0 grid place-items-center text-sm opacity-60">Unlocking…</div>;
  }
  const addHomeModal = showAddHome ? (
    <AddHomeModal
      onAdd={(url) => {
        addHome(url);
        setShowAddHome(false);
      }}
      onClose={() => setShowAddHome(false)}
    />
  ) : null;
  if (!token) {
    return (
      <>
        <AuthScreen
          home={activeHome}
          homes={homes}
          onAuth={handleAuth}
          onSwitchHome={setActiveHomeId}
          onAddHome={() => setShowAddHome(true)}
        />
        {addHomeModal}
      </>
    );
  }
  return (
    <>
      <MainApp
        key={activeHome.id}
        token={token}
        homes={homes}
        activeHomeId={activeHome.id}
        onSwitchHome={setActiveHomeId}
        onAddHome={() => setShowAddHome(true)}
        onLogout={handleLogout}
      />
      {addHomeModal}
    </>
  );
}

function AddHomeModal({ onAdd, onClose }: { onAdd: (url: string) => void; onClose: () => void }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const trimmed = url.trim();

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!trimmed) return;
    try {
      onAdd(trimmed);
    } catch {
      setError("That does not look like an Ohiyo home link. Paste the full https:// address and try again.");
    }
  }

  return (
    <ModalShell onClose={onClose} labelledBy="kc-add-home-title" maxWidthClass="max-w-md">
      <h2
        id="kc-add-home-title"
        style={{ fontFamily: "var(--font-display)", fontWeight: 800, fontSize: "var(--text-2xl)", color: "var(--text-primary)" }}
      >
        Add an Ohiyo home
      </h2>
      <p className="mt-2 text-sm leading-6" style={{ color: "var(--text-muted)" }}>
        Paste the invite or home link you were given. Most people only need the default home already selected.
      </p>
      <form onSubmit={submit} className="mt-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Home link
          <input
            value={url}
            onChange={(e) => { setUrl(e.target.value); setError(null); }}
            placeholder="https://your-ohiyo-home.example"
            aria-label="Ohiyo home link"
            autoComplete="url"
            className="kc-field px-3.5 py-3 text-sm outline-none"
          />
        </label>
        {error && (
          <div role="alert" className="rounded-xl px-3 py-2 text-sm" style={{ background: "color-mix(in oklch, var(--danger) 12%, var(--bg-elevated))", color: "var(--danger)" }}>
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="kc-interactive rounded-full px-4 py-2 text-sm font-semibold" style={{ background: "var(--bg-input)", color: "var(--text-secondary)", border: "none" }}>
            Cancel
          </button>
          <button type="submit" disabled={!trimmed} className="kc-cta rounded-full px-4 py-2 text-sm" style={{ opacity: trimmed ? 1 : 0.6 }}>
            Add home
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function MainApp({
  token,
  homes,
  activeHomeId,
  onSwitchHome,
  onAddHome,
  onLogout,
}: {
  token: string;
  homes: OhiyoHome[];
  activeHomeId: string;
  onSwitchHome: (id: string) => void;
  onAddHome: () => void;
  onLogout: () => void;
}) {
  const { toasts, push: toast } = useToast();
  const [currentUser, setCurrentUser] = useState<PublicUser | null>(null);
  // Whether this server runs the LiveKit SFU — fetched at runtime from /livekit/config,
  // so the same desktop build works against a mesh-only or an SFU-backed deployment.
  const [liveKitEnabled, setLiveKitEnabled] = useState(false);
  const [servers, setServers] = useState<ServerWithChannels[]>([]);
  const [dms, setDms] = useState<Channel[]>([]);
  // Live participant lists for group DMs, keyed by channel id (kept fresh by
  // GroupMembersUpdate; seeded on demand by the members popover).
  const [groupMembers, setGroupMembers] = useState<Record<string, PublicUser[]>>({});
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [selectedChannel, setSelectedChannel] = useState<Channel | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [serverEmojis, setServerEmojis] = useState<ServerEmoji[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<Tab>("appearance");
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showCreateServer, setShowCreateServer] = useState(false);
  const [showDiscordImport, setShowDiscordImport] = useState(false);
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
  // Seeded per-account from `kc:welcomed:<userId>` once we know who logged in (in the
  // Ready handler) — so a different account on a shared device isn't treated as welcomed.
  const [welcomed, setWelcomed] = useState(false);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [mentions, setMentions] = useState<Set<string>>(new Set());
  // Read receipts: channelId → (userId → last_read_at watermark). Drives the
  // Delivered/Seen indicator in DMs.
  const [receipts, setReceipts] = useState<Record<string, Record<string, number>>>({});
  const [myStatus, setMyStatus] = useState<string | null>(null);
  const [privacyPrefs, setPrivacyPrefs] = useState<PrivacyPrefs>(loadLocalPrivacyPrefs);
  const privacyMode = privacyPrefs.metadataMode;
  const typing = useTyping(currentUser?.id ?? "");
  const [connStatus, setConnStatus] = useState<ConnectionStatus>("connecting");

  // Desktop deep links: opening ohiyo://invite/<code> (cold start or while
  // running) routes into the join screen. No-op in the browser.
  useEffect(() => {
    let cleanup = () => {};
    void initDeepLinks((code) => setInviteCode(code)).then((fn) => {
      cleanup = fn;
    });
    return () => cleanup();
  }, []);
  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());
  const [idleUsers, setIdleUsers] = useState<Set<string>>(new Set());
  const [activities, setActivities] = useState<Map<string, Activity>>(new Map());
  const [watchSession, setWatchSession] = useState<WatchSession | null>(null);
  const [voiceMembers, setVoiceMembers] = useState<Map<string, string>>(new Map()); // userId → voice channelId
  const [chatActivityNotices, setChatActivityNotices] = useState<Array<ChatActivityNotice & { channelId: string }>>([]);
  const [e2eChannels, setE2eChannels] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem("kc:e2e-channels") || "[]"));
    } catch {
      return new Set<string>();
    }
  });
  const selectedChannelRef = useRef<Channel | null>(null);
  const selectedServerIdRef = useRef<string | null>(null);
  // Last message id we've acked per channel — dedupes redundant read receipts.
  const lastAckRef = useRef<Record<string, string>>({});
  const didAutoSelectRef = useRef(false);
  const notifyAskedRef = useRef(false);
  const handleSelectChannelRef = useRef<(channel: Channel) => void>(() => {});
  const currentUserRef = useRef<PublicUser | null>(null);
  // E2E: mirror DM state into refs so the stable send/decrypt callbacks read live values.
  const e2eChannelsRef = useRef(e2eChannels);
  e2eChannelsRef.current = e2eChannels;
  const dmUsersRef = useRef(dmUsers);
  dmUsersRef.current = dmUsers;
  const dmKeyCacheRef = useRef<Map<string, CryptoKey>>(new Map());
  const dmPeerRef = useRef<Map<string, string>>(new Map()); // channelId → peer userId (learned from messages)
  const serversRef = useRef<ServerWithChannels[]>([]);
  const gatewayRef = useRef<Gateway | null>(null);
  const privacyModeRef = useRef(privacyMode);
  privacyModeRef.current = privacyMode;

  /** Set or clear my rich-presence activity; the server echoes it back to update UI. */
  function updateActivity(activity: Activity | null) {
    if (privacyModeRef.current && activity) return;
    gatewayRef.current?.send({ t: "SetActivity", d: { activity } });
  }

  async function updatePrivacyPrefs(next: PrivacyPrefs) {
    setPrivacyPrefs(next);
    saveLocalPrivacyPrefs(next);
    gatewayRef.current?.send({ t: "SetPrivacyMode", d: { enabled: next.metadataMode } });
    if (next.metadataMode) {
      setActivities((prev) => {
        const mine = currentUserRef.current?.id;
        if (!mine || !prev.has(mine)) return prev;
        const copy = new Map(prev);
        copy.delete(mine);
        return copy;
      });
      gatewayRef.current?.send({ t: "SetActivity", d: { activity: null } });
    }
    try {
      const prefs = await api.getPrefs(token);
      await api.setPrefs(token, mergePrivacyIntoPrefs(prefs, next));
      toast(next.metadataMode ? "Privacy Mode on" : "Privacy Mode off", "success");
    } catch {
      toast("Privacy Mode saved on this device; server sync will retry next time.", "info");
    }
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

  /** Add a soft, non-persistent note to the currently open chat. */
  function pushChatActivityNotice(channelId: string, notice: ChatActivityNotice) {
    setChatActivityNotices((prev) => [...prev.slice(-7), { ...notice, channelId }]);
    window.setTimeout(() => {
      setChatActivityNotices((prev) => prev.filter((item) => item.id !== notice.id));
    }, 45_000);
  }

  /** Join a friend's voice channel by id (from their presence "Join" button). */
  function joinVoiceById(channelId: string) {
    const ch = selectedServer?.channels?.find((c) => c.id === channelId);
    if (ch) handleJoinVoice(ch);
  }

  // Watch → Play: while a watch party is active in the channel you're viewing, show
  // friends "📺 Watching …" automatically (cleared when the party ends).
  const watchActivityRef = useRef(false);
  useEffect(() => {
    if (privacyMode) {
      if (watchActivityRef.current) {
        watchActivityRef.current = false;
        updateActivity(null);
      }
      return;
    }
    if (watchSession && !watchActivityRef.current) {
      watchActivityRef.current = true;
      const label = /youtu\.?be/.test(watchSession.url) ? "YouTube" : "a video";
      updateActivity({ kind: "watching", name: label });
    } else if (!watchSession && watchActivityRef.current) {
      watchActivityRef.current = false;
      updateActivity(null);
    }
  }, [watchSession, privacyMode]);

  // Publish this device's E2E public key once we're signed in (idempotent upsert).
  useEffect(() => {
    if (!currentUser) return;
    let alive = true;
    void (async () => {
      // Desktop: move E2E key storage into the native locked-RAM vault BEFORE any key
      // access (no-op + localStorage in a browser). Keys never sit plaintext on disk.
      await initVaultBackend();
      if (!alive) return;
      myKeyPair()
        .then((kp) => {
          if (alive) void api.publishKey(token, JSON.stringify(kp.publicJwk));
        })
        .catch(() => {});
      // Generate + publish Signal prekeys (forward-secret X3DH sessions). Idempotent;
      // makes every signed-in user Signal-capable. The DM-flow switch builds on this.
      void initSignal(token);
      // Sync appearance (theme + accent) from the server so it follows the user across
      // devices. Local appearance already painted at boot; this reconciles.
      void pullAppearance(token);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key off the user identity (id), not every currentUser object
  }, [currentUser?.id, token]);
  const webrtcRef = useRef<UseWebRTCReturn | null>(null);
  const activeVoiceRef = useRef<string | null>(null);

  // Voice engine. Both hooks are called unconditionally (rules of hooks); liveKitEnabled
  // (fetched at runtime from /livekit/config) picks the P2P mesh (default) or the LiveKit
  // SFU (scales past ~5 participants). Either way signaling/presence flows through the gateway.
  //
  // The callbacks object MUST keep a stable identity across renders — the WebRTC hooks
  // store it and a new object each render would churn their effects. Changing values
  // (currentUserId, token) are read through a ref updated every render instead.
  const webrtcStateRef = useRef({ currentUserId: currentUser?.id ?? "", token });
  webrtcStateRef.current = { currentUserId: currentUser?.id ?? "", token };
  const webrtcCallbacks = useRef<WebRTCCallbacks>({
    get currentUserId() {
      return webrtcStateRef.current.currentUserId;
    },
    getIceServers: async () => (await api.getIceServers(webrtcStateRef.current.token)).iceServers,
    sendJoin: (cid: string, muted: boolean, video: boolean, listenOnly: boolean) =>
      gatewayRef.current?.send({ t: "JoinVoice", d: { channel_id: cid, muted, video, listen_only: listenOnly } }),
    sendLeave: (cid: string) => gatewayRef.current?.send({ t: "LeaveVoice", d: { channel_id: cid } }),
    sendMeta: (cid: string, muted: boolean, video: boolean, screen: boolean, listenOnly: boolean) =>
      gatewayRef.current?.send({ t: "VoiceMeta", d: { channel_id: cid, muted, video, screen, listen_only: listenOnly } }),
    sendSignal: (to: string, kind: string, payload: string) =>
      gatewayRef.current?.send({
        t: "Signal",
        d: { to, channel_id: activeVoiceRef.current ?? "", kind, payload },
      }),
  }).current;
  const mesh = useWebRTC(webrtcCallbacks);
  const sfu = useWebRTCLiveKit(webrtcCallbacks, token);
  const webrtc = liveKitEnabled ? sfu : mesh;
  // Keep refs in sync after commit (concurrent-safe — no ref writes during render).
  useLayoutEffect(() => {
    webrtcRef.current = webrtc;
    activeVoiceRef.current = webrtc.channelId;
    // Keep the gateway handler's view of channel selection current (avoids a
    // stale closure: handleGatewayEvent is registered once per token).
    handleSelectChannelRef.current = handleSelectChannel;
  });

  // Discover whether this deployment runs the LiveKit SFU (runtime, not a build-time
  // flag), so one shipped build adapts to either a mesh-only or an SFU-backed server.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api
      .getLiveKitConfig(token)
      .then((cfg) => {
        if (!cancelled) setLiveKitEnabled(cfg.enabled);
      })
      .catch(() => {
        if (!cancelled) setLiveKitEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  useEffect(() => { selectedChannelRef.current = selectedChannel; }, [selectedChannel]);
  useEffect(() => {
    if (!selectedChannel?.id) return;
    setChatActivityNotices((prev) => prev.filter((notice) => notice.channelId === selectedChannel.id));
  }, [selectedChannel?.id]);

  // Disappearing messages: prune locally the instant a message's TTL lapses, so it
  // vanishes immediately rather than lingering until the server's sweep broadcast.
  // The interval only runs while at least one timed message is on screen.
  const hasTimedMessages = messages.some((m) => m.expires_at);
  useEffect(() => {
    if (!hasTimedMessages) return;
    const id = setInterval(() => {
      const now = Math.floor(Date.now() / 1000);
      setMessages((prev) => {
        const expired = prev.filter((m) => m.expires_at && m.expires_at <= now);
        if (expired.length === 0) return prev;
        // Evict the forward-secret plaintext for disappeared messages so they can't be
        // recovered from the on-disk cache (idempotent — safe under updater re-invocation).
        for (const m of expired) removeCachedPlaintext(m.id);
        return prev.filter((m) => !(m.expires_at && m.expires_at <= now));
      });
    }, 1000);
    return () => clearInterval(id);
  }, [hasTimedMessages]);
  useEffect(() => {
    currentUserRef.current = currentUser;
    window.__kikkacordUser = currentUser;
  }, [currentUser]);

  // Load our saved privacy prefs once we're known. Local prefs seed first paint;
  // server prefs win after login so Privacy Mode follows the account across devices.
  useEffect(() => {
    if (!currentUser) return;
    let alive = true;
    api.getPrefs(token)
      .then((prefs) => {
        if (!alive) return;
        const privacy = readPrivacyPrefs(prefs);
        setPrivacyPrefs(privacy);
        saveLocalPrivacyPrefs(privacy);
        gatewayRef.current?.send({ t: "SetPrivacyMode", d: { enabled: privacy.metadataMode } });
      })
      .catch(() => {});
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on the user identity (id), not every currentUser object change
  }, [currentUser?.id, token]);

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
    document.title = total > 0 ? `(${total}) Ohiyo` : "Ohiyo";
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

  // Idle detection: no input for 5 minutes (or the tab hidden) → tell the server we're
  // idle so peers see an amber dot; any activity flips us back to online.
  useEffect(() => {
    if (!currentUser || privacyMode) return;
    const IDLE_MS = 5 * 60 * 1000;
    let idle = false;
    let timer: ReturnType<typeof setTimeout>;
    const setIdle = (next: boolean) => {
      if (next === idle) return;
      idle = next;
      gatewayRef.current?.send({ t: "SetPresence", d: { idle: next } });
    };
    const onActivity = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), IDLE_MS);
    };
    const onVisibility = () => (document.hidden ? setIdle(true) : onActivity());
    const events: (keyof WindowEventMap)[] = ["mousemove", "keydown", "mousedown", "touchstart", "scroll"];
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }));
    document.addEventListener("visibilitychange", onVisibility);
    onActivity(); // start the timer
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, onActivity));
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key on user identity; sends via the gateway ref
  }, [currentUser?.id, privacyMode]);

  // Learn a group's current rekey epoch from the server. If it advanced past our own
  // sender key, setGroupEpoch rotates us to a fresh key — then re-fan it to the
  // remaining members (clear the once-per-session guard so the next send redistributes,
  // and push it now if the group is already in encrypted mode). Hoisted, so the gateway
  // handler can call it before distributeMySenderKey is declared below.
  function syncGroupEpoch(channelId: string, epoch: number | undefined): void {
    void setGroupEpoch(channelId, epoch ?? 0).then((rotated) => {
      if (!rotated) return;
      distributedGroupsRef.current.delete(channelId);
      if (e2eChannelsRef.current.has(channelId)) void distributeMySenderKey(channelId);
    });
  }

  function handleGatewayEvent(event: GatewayEvent) {
    switch (event.t) {
      case "Ready":
        gatewayRef.current?.send({ t: "SetPrivacyMode", d: { enabled: privacyModeRef.current } });
        setCurrentUser(event.d.user);
        setServers(event.d.servers);
        setDms(event.d.dms);
        // Catch up on group rekeys that happened while we were offline: if a group's
        // server epoch is ahead of our own sender key, this rotates us and redistributes.
        for (const d of event.d.dms) {
          if (d.channel_type === "group_dm") syncGroupEpoch(d.id, d.epoch);
        }
        // Seed unread badges from the server so they no longer wipe to zero on reload.
        setUnread(event.d.unread ?? {});
        // Per-account onboarding flag (same batch as currentUser → no onboarding flash).
        try {
          setWelcomed(localStorage.getItem(`kc:welcomed:${event.d.user.id}`) === "1");
        } catch {
          /* storage off */
        }
        // Smooth landing: on first connect, drop the user back where they left off
        // (persisted last channel) — else the first server's first text channel. Runs
        // once per load so reconnects never yank you around.
        if (!didAutoSelectRef.current && !selectedChannelRef.current) {
          didAutoSelectRef.current = true;
          const lastId = (() => {
            try {
              return localStorage.getItem("kc:last-channel");
            } catch {
              return null;
            }
          })();
          const findChannel = (id: string): Channel | null => {
            for (const s of event.d.servers) {
              const c = s.channels.find((ch) => ch.id === id);
              if (c) return c;
            }
            return event.d.dms.find((d) => d.id === id) ?? null;
          };
          const target =
            (lastId ? findChannel(lastId) : null) ??
            event.d.servers[0]?.channels.find((c) => c.channel_type === "text") ??
            null;
          if (target) {
            setSelectedServerId(target.server_id ?? null);
            handleSelectChannelRef.current(target);
          }
        }
        pluginManagerRef.current.emit("ready", event.d);
        break;

      case "MessageCreate": {
        const msg = event.d;
        typing.clearTyping(msg.channel_id, msg.author.id);
        if (selectedChannelRef.current?.id === msg.channel_id) {
          // Dedup by id: a duplicate MessageCreate (gateway replay, or a resend whose
          // first response was lost) must not render the message twice.
          setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
          if (isEncrypted(msg.content) || isSignalCiphertext(msg.content) || isGroupCiphertext(msg.content)) {
            void decryptMessages(msg.channel_id, [msg]).then((dec) => {
              const dm = dec[0];
              if (dm) setMessages((prev) => prev.map((m) => (m.id === dm.id ? dm : m)));
            });
          }
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
          mentionsYou(msg.content, currentUserRef.current.username)
        ) {
          setMentions((prev) => {
            const next = new Set(prev);
            next.add(msg.channel_id);
            return next;
          });
        }
        maybeNotify(
          isEncrypted(msg.content) || isSignalCiphertext(msg.content) || isGroupCiphertext(msg.content)
            ? { ...msg, content: "🔒 Sent an encrypted message" }
            : msg
        );
        pluginManagerRef.current.emit("message", msg);
        break;
      }

      case "MessageUpdate": {
        const msg = event.d;
        setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
        // Edited E2E messages arrive as ciphertext — decrypt for the viewer (mirrors MessageCreate).
        if (isEncrypted(msg.content) || isSignalCiphertext(msg.content) || isGroupCiphertext(msg.content)) {
          void decryptMessages(msg.channel_id, [msg]).then((dec) => {
            const dm = dec[0];
            if (dm) setMessages((prev) => prev.map((m) => (m.id === dm.id ? dm : m)));
          });
        }
        break;
      }

      case "MessageDelete":
        removeCachedPlaintext(event.d.id); // drop the forward-secret plaintext too
        setMessages((prev) => prev.filter((m) => m.id !== event.d.id));
        break;

      case "DisappearingUpdate": {
        const { channel_id, seconds } = event.d;
        const patch = (c: Channel): Channel =>
          c.id === channel_id ? { ...c, disappearing_seconds: seconds } : c;
        setDms((prev) => prev.map(patch));
        setServers((prev) => prev.map((s) => ({ ...s, channels: s.channels.map(patch) })));
        setSelectedChannel((prev) => (prev ? patch(prev) : prev));
        if (selectedChannelRef.current?.id === channel_id) {
          toast(seconds ? `Disappearing messages: ${formatDuration(seconds)}` : "Disappearing messages off");
        }
        break;
      }

      case "SenderKeyDistribution": {
        // A group member handed us their sender key (group E2E bootstrap). Decrypt the
        // pairwise envelope and install it so we can read their group messages.
        const { channel_id, from_user_id, envelope } = event.d;
        void decryptFrom(from_user_id, envelope).then((skdm) => {
          if (skdm) installDistribution(channel_id, from_user_id, skdm);
        });
        break;
      }

      case "GroupMembersUpdate": {
        // A group DM's membership changed. If we're no longer in the participant list,
        // we were removed (or left) → drop the channel. Otherwise reflect the new epoch
        // (rotating our sender key if it advanced) and refresh the member list.
        const { channel_id, epoch, participants } = event.d;
        const myId = currentUserRef.current?.id;
        if (myId && !participants.some((p) => p.id === myId)) {
          setDms((prev) => prev.filter((d) => d.id !== channel_id));
          setGroupMembers((m) => {
            const next = { ...m };
            delete next[channel_id];
            return next;
          });
          if (selectedChannelRef.current?.id === channel_id) {
            setSelectedChannel(null);
            selectedChannelRef.current = null;
            toast("You were removed from the group");
          }
          break;
        }
        const patchEpoch = (c: Channel): Channel => (c.id === channel_id ? { ...c, epoch } : c);
        setDms((prev) => prev.map(patchEpoch));
        setSelectedChannel((prev) => (prev ? patchEpoch(prev) : prev));
        setGroupMembers((m) => ({ ...m, [channel_id]: participants }));
        syncGroupEpoch(channel_id, epoch);
        break;
      }

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
        if (event.d.server_id) {
          setServers((prev) =>
            prev.map((s) =>
              s.id === event.d.server_id ? { ...s, channels: [...s.channels, event.d] } : s
            )
          );
        } else {
          // A DM / group DM (no server) → add it to the DM list live.
          setDms((prev) => (prev.some((d) => d.id === event.d.id) ? prev : [event.d, ...prev]));
          // Joining a group at its current epoch seeds our first sender key in the live
          // generation (a member added mid-life starts at epoch N, not 0).
          if (event.d.channel_type === "group_dm") syncGroupEpoch(event.d.id, event.d.epoch);
        }
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
        const currentChannel = selectedChannelRef.current;
        if (currentChannel?.server_id === server_id && user.id !== currentUserRef.current?.id) {
          pushChatActivityNotice(currentChannel.id, {
            id: `join-${server_id}-${user.id}-${Date.now()}`,
            kind: "join",
            text: `${user.display_name} joined the space`,
            createdAt: Date.now(),
            user,
          });
        }
        break;
      }

      case "MemberLeave": {
        const { server_id, user_id } = event.d;
        const leavingUser = serversRef.current.find((s) => s.id === server_id)?.members.find((m) => m.id === user_id);
        const currentChannel = selectedChannelRef.current;
        if (currentChannel?.server_id === server_id && user_id !== currentUserRef.current?.id && leavingUser) {
          pushChatActivityNotice(currentChannel.id, {
            id: `leave-${server_id}-${user_id}-${Date.now()}`,
            kind: "leave",
            text: `${leavingUser.display_name} left the space`,
            createdAt: Date.now(),
            user: leavingUser,
          });
        }
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
        if (privacyModeRef.current) break;
        const { channel_id, user_id, last_read_at } = event.d;
        setReceipts((prev) => {
          const chan = prev[channel_id] ?? {};
          if ((chan[user_id] ?? 0) >= last_read_at) return prev; // monotonic — never rewind
          return { ...prev, [channel_id]: { ...chan, [user_id]: last_read_at } };
        });
        break;
      }

      case "PresenceUpdate": {
        const { user_id, online, status, activity } = event.d;
        setOnlineUsers((prev) => {
          const next = new Set(prev);
          if (online) next.add(user_id);
          else next.delete(user_id);
          return next;
        });
        setIdleUsers((prev) => {
          const isIdle = online && status === "idle";
          if (isIdle === prev.has(user_id)) return prev;
          const next = new Set(prev);
          if (isIdle) next.add(user_id);
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
        if (privacyModeRef.current) break;
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

      case "VoiceKeyDistribution":
        // A call participant relayed their voice E2EE room key — hand it to the active
        // voice engine to converge the shared FrameCryptor key.
        void webrtcRef.current?.onVoiceKey(event.d.channel_id, event.d.from_user_id, event.d.envelope);
        break;

      case "VoiceState": {
        webrtcRef.current?.onVoiceState(event.d);
        const { user_id, channel_id, joined } = event.d;
        setVoiceMembers((prev) => {
          const next = new Map(prev);
          if (joined) next.set(user_id, channel_id);
          else if (next.get(user_id) === channel_id) next.delete(user_id);
          return next;
        });
        break;
      }
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
    // Remember where you are so a reload drops you back here, not channel #1.
    try {
      localStorage.setItem("kc:last-channel", channel.id);
    } catch {
      /* storage off — non-fatal */
    }
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
      // Decrypt any E2E messages for display before showing them.
      const shown = await decryptMessages(channel.id, msgs);
      if (selectedChannelRef.current?.id !== channel.id) return;
      // Re-attach any unsent/failed messages queued for this channel.
      const queued = outboxForChannel(channel.id);
      setMessages(queued.length ? [...shown, ...queued] : shown);
      // Opening the channel marks it read on the server (drives our unread state).
      // In Privacy Mode the server still stores my read cursor for my UX, but it
      // suppresses peer-visible "Seen" receipts.
      sendAck(channel.id, lastRealMessageId(msgs));
      // For DMs, hydrate existing Delivered/Seen state; live updates then arrive
      // via the ReadReceipt gateway event. Privacy Mode hides this live metadata UI.
      if (!channel.server_id && !privacyModeRef.current) {
        api.listReads(token, channel.id)
          .then((cursors) => {
            if (selectedChannelRef.current?.id !== channel.id || privacyModeRef.current) return;
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

  // Resolve a DM peer's user id (learned from message authors, or dmUsers).
  const dmPeerId = useCallback(
    (channelId: string): string | undefined =>
      dmPeerRef.current.get(channelId) ?? dmUsersRef.current[channelId]?.id,
    []
  );

  // Verification state for the open DM's peer — drives the "safety number changed"
  // warning + the Verified badge. identityTrust is an external store; subscribing
  // re-renders on any key-change / verify / dismiss without manual ticks.
  const e2eTrust = useSyncExternalStore<TrustState>(onIdentityChange, () => {
    const peer = selectedChannel?.channel_type === "dm" ? dmPeerId(selectedChannel.id) : undefined;
    return peer ? trustState(peer) : "unverified";
  });

  // E2E: derive (and cache) the shared AES key for a DM from my private key + the
  // peer's published public key (LEGACY static-key scheme; new sessions use Signal).
  const getDmKey = useCallback(
    async (channelId: string): Promise<CryptoKey | null> => {
      const cached = dmKeyCacheRef.current.get(channelId);
      if (cached) return cached;
      // Peer = the learned message-author OR dmUsers (whichever we know).
      const peerId = dmPeerRef.current.get(channelId) ?? dmUsersRef.current[channelId]?.id;
      if (!peerId) return null;
      try {
        const { public_key } = await api.getUserKey(token, peerId);
        if (!public_key) return null;
        const mine = await myKeyPair();
        const key = await deriveSharedKey(mine.privateJwk, JSON.parse(public_key) as JsonWebKey);
        dmKeyCacheRef.current.set(channelId, key); // cache only successful derivations
        return key;
      } catch {
        return null;
      }
    },
    [token]
  );

  // Decrypt E2E ciphertext in a message list for display (plaintext stays on-device).
  // Two schemes coexist: forward-secret Signal (`sig1.`) and legacy static-key (`v1.`).
  // Signal messages can only be decrypted once — the ratchet destroys the key — so we
  // cache the plaintext locally and reuse it on later reloads.
  // Group E2E (sender keys): distribute MY sender key to every other group member,
  // encrypted pairwise so the server stays blind. Idempotent — once per group/session.
  const distributedGroupsRef = useRef<Set<string>>(new Set());
  const distributeMySenderKey = useCallback(
    async (channelId: string) => {
      if (distributedGroupsRef.current.has(channelId)) return;
      distributedGroupsRef.current.add(channelId);
      try {
        const recipients = await api.listRecipients(token, channelId);
        const myId = currentUserRef.current?.id;
        const skdm = await buildDistribution(channelId);
        const envelopes: Record<string, string> = {};
        for (const r of recipients) {
          if (r.id === myId) continue;
          const env = await encryptFor(token, r.id, skdm);
          if (env) envelopes[r.id] = env;
        }
        if (Object.keys(envelopes).length) await api.distributeSenderKey(token, channelId, envelopes);
      } catch {
        distributedGroupsRef.current.delete(channelId); // allow a retry on next send
      }
    },
    [token]
  );

  const decryptMessages = useCallback(
    async (channelId: string, msgs: Message[]): Promise<Message[]> => {
      if (
        !msgs.some((m) => isEncrypted(m.content) || isSignalCiphertext(m.content) || isGroupCiphertext(m.content))
      )
        return msgs;
      // The conversation is encrypted → reflect it locally (sticky + mutual): the
      // recipient's UI flips to encrypted mode and their replies encrypt too.
      setE2eChannels((prev) => {
        if (prev.has(channelId)) return prev;
        const next = new Set(prev);
        next.add(channelId);
        localStorage.setItem("kc:e2e-channels", JSON.stringify([...next]));
        return next;
      });
      // Learn the DM peer from message authors (resilient to un-hydrated dmUsers).
      if (!dmPeerRef.current.has(channelId)) {
        const myId = currentUserRef.current?.id;
        const peer = msgs.find((m) => m.author.id !== myId)?.author.id;
        if (peer) dmPeerRef.current.set(channelId, peer);
      }
      const peerId = dmPeerId(channelId);
      // Legacy static key only fetched if any v1 messages are present.
      const legacyKey = msgs.some((m) => isEncrypted(m.content)) ? await getDmKey(channelId) : null;
      // Sequential: the Double Ratchet requires in-order processing of new messages.
      const out: Message[] = [];
      for (const m of msgs) {
        if (isGroupCiphertext(m.content)) {
          // Group sender-key message — decrypt from the message author's sender key.
          const cached = getCachedPlaintext(m.id);
          if (cached !== null) {
            out.push({ ...m, content: cached, _encrypted: true });
            continue;
          }
          const pt = await groupDecrypt(channelId, m.author.id, m.content);
          if (pt !== null) cachePlaintext(m.id, pt);
          out.push({ ...m, content: pt ?? "🔒 Encrypted message", _encrypted: true });
        } else if (isSignalCiphertext(m.content)) {
          const cached = getCachedPlaintext(m.id);
          if (cached !== null) {
            out.push({ ...m, content: cached, _encrypted: true });
            continue;
          }
          const pt = peerId ? await decryptFrom(peerId, m.content) : null;
          if (pt !== null) cachePlaintext(m.id, pt);
          out.push({ ...m, content: pt ?? "🔒 Encrypted message", _encrypted: true });
        } else if (isEncrypted(m.content)) {
          const pt = legacyKey ? await decryptMessage(legacyKey, m.content) : null;
          out.push({ ...m, content: pt ?? "🔒 Encrypted message", _encrypted: true });
        } else {
          out.push(m);
        }
      }
      return out;
    },
    [getDmKey, dmPeerId]
  );

  // Flip a DM into (or out of) end-to-end encrypted mode — persisted; the chat shifts
  // to a darker "encrypted" look. Keys are handled automatically; the user just clicks.
  const toggleE2e = useCallback(
    (channelId: string) => {
      const isGroup = selectedChannelRef.current?.channel_type === "group_dm";
      setE2eChannels((prev) => {
        const next = new Set(prev);
        if (next.has(channelId)) {
          next.delete(channelId);
        } else {
          next.add(channelId);
          if (isGroup) {
            // Group: hand my sender key to every member so they can read my messages.
            void distributeMySenderKey(channelId);
          } else {
            void getDmKey(channelId).then((k) => {
              if (!k) toast("Your friend hasn't set up encryption yet — they just need to open Ohiyo once.");
            });
          }
        }
        localStorage.setItem("kc:e2e-channels", JSON.stringify([...next]));
        return next;
      });
    },
    [getDmKey, toast, distributeMySenderKey]
  );

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
        const cid = selectedChannelRef.current!.id;
        const isGroup = selectedChannelRef.current!.channel_type === "group_dm";
        let wire = content;
        // E2E: encrypt on this device before it leaves — the server only sees ciphertext.
        if (content && e2eChannelsRef.current.has(cid)) {
          if (isGroup) {
            // Group: encrypt once with our sender key (every member decrypts the same
            // ciphertext). Ensure our key is distributed first (idempotent).
            await distributeMySenderKey(cid);
            const g = await groupEncrypt(cid, content);
            if (g) wire = g;
          } else {
            // 1:1: require a forward-secret Signal session. We no longer fall back to
            // the legacy static-key scheme (zero forward secrecy) — and never to
            // plaintext. If there's no session yet, abort so the message stays
            // retryable once the peer publishes prekeys.
            const peerId = dmPeerId(cid);
            const sig = peerId ? await encryptFor(token, peerId, content) : null;
            if (!sig) {
              toast("Can't send encrypted yet — your friend needs to open Ohiyo once to set up encryption.");
              throw new Error("no-signal-session");
            }
            wire = sig;
          }
        }
        const created = await api.sendMessage(token, cid, wire, attachmentIds, replyTo);
        // Forward secrecy: we can't decrypt our own outgoing ciphertext later (1:1
        // ratchet or group sender key), so cache the plaintext by the real message id.
        if ((isSignalCiphertext(wire) || isGroupCiphertext(wire)) && created?.id) {
          cachePlaintext(created.id, content);
          // If the gateway echo already rendered this as a placeholder (it can't
          // self-decrypt), patch it back to plaintext now.
          setMessages((prev) =>
            prev.map((m) => (m.id === created.id ? { ...m, content, _encrypted: true } : m))
          );
        }
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
        removeFromOutbox(tempId);
      } catch {
        // Keep the message visible in a failed state (persisted) so it can be retried.
        setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, _state: "failed" } : m)));
        setOutboxState(tempId, "failed");
      }
    },
    [token, dmPeerId, toast, distributeMySenderKey]
  );

  // Retry a failed/queued message using its stored send args.
  const handleRetryMessage = useCallback(
    async (msg: Message) => {
      const send = msg._send;
      if (!send) return;
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, _state: "pending" } : m)));
      setOutboxState(msg.id, "pending");
      try {
        let wire = send.content;
        if (send.content && e2eChannelsRef.current.has(msg.channel_id)) {
          // A group sender key exists only for group channels (else null → 1:1 path).
          const g = await groupEncrypt(msg.channel_id, send.content);
          if (g) {
            wire = g;
          } else {
            const peerId = dmPeerId(msg.channel_id);
            const sig = peerId ? await encryptFor(token, peerId, send.content) : null;
            if (!sig) throw new Error("no-signal-session"); // stays failed/retryable
            wire = sig;
          }
        }
        const created = await api.sendMessage(token, msg.channel_id, wire, send.attachmentIds, send.replyTo ?? null);
        if ((isSignalCiphertext(wire) || isGroupCiphertext(wire)) && created?.id) {
          cachePlaintext(created.id, send.content);
          setMessages((prev) =>
            prev.map((m) => (m.id === created.id ? { ...m, content: send.content, _encrypted: true } : m))
          );
        }
        setMessages((prev) => prev.filter((m) => m.id !== msg.id));
        removeFromOutbox(msg.id);
      } catch {
        setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, _state: "failed" } : m)));
        setOutboxState(msg.id, "failed");
      }
    },
    [token, dmPeerId]
  );

  // Drop a failed message (it never reached the server).
  const handleDiscardFailed = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
    removeFromOutbox(id);
  }, []);

  // Re-send everything still queued in the outbox (called on connectivity return).
  const flushingRef = useRef(false);
  const flushOutbox = useCallback(() => {
    // Single-flight + sequential: firing all retries in parallel lets messages land out
    // of order, and the two reconnect paths (the `online` listener and the connected
    // effect) can otherwise overlap. The guard keeps the signature sync for the callers.
    if (flushingRef.current) return;
    flushingRef.current = true;
    void (async () => {
      try {
        for (const m of pendingFailedOutbox()) await handleRetryMessage(m);
      } finally {
        flushingRef.current = false;
      }
    })();
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
    const ch = selectedChannelRef.current;
    const cid = ch?.id;
    if (!cid) return;
    try {
      let wire = content;
      // E2E: encrypt the edit on-device too — editing must NOT leak plaintext to the
      // server (mirrors handleSend; without this an edited E2E message went out in clear).
      if (content && e2eChannelsRef.current.has(cid)) {
        if (ch?.channel_type === "group_dm") {
          await distributeMySenderKey(cid);
          const g = await groupEncrypt(cid, content);
          if (g) wire = g;
        } else {
          const peerId = dmPeerId(cid);
          const sig = peerId ? await encryptFor(token, peerId, content) : null;
          if (!sig) {
            toast("Can't edit encrypted yet — your friend needs to open Ohiyo once to set up encryption.");
            return;
          }
          wire = sig;
        }
      }
      await api.editMessage(token, cid, messageId, wire);
      // Forward secrecy: cache the new plaintext under the message id so our own view
      // (and later history reloads) shows it — we can't re-decrypt our own ciphertext.
      if (isSignalCiphertext(wire) || isGroupCiphertext(wire)) {
        cachePlaintext(messageId, content);
        setMessages((prev) =>
          prev.map((m) => (m.id === messageId ? { ...m, content, _encrypted: true } : m))
        );
      }
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
    // Native OS notification under Tauri, Web Notification in a browser — but only from
    // ONE tab/window when several are open (claimNotification), so no double-ping.
    void claimNotification(msg.id).then((mine) => {
      if (mine) void notify({ title: msg.author.display_name, body });
    });
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
    if (privacyModeRef.current) return;
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
    if (currentUser) {
      try {
        localStorage.setItem(`kc:welcomed:${currentUser.id}`, "1");
      } catch {
        /* storage off */
      }
    }
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
      throw err;
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

  function handleCurrentUserUpdate(user: PublicUser) {
    setCurrentUser(user);
    setServers((prev) =>
      prev.map((s) => ({
        ...s,
        members: s.members.map((m) => (m.id === user.id ? user : m)),
      }))
    );
    setMessages((prev) => prev.map((m) => (m.author.id === user.id ? { ...m, author: user } : m)));
    setGroupMembers((prev) =>
      Object.fromEntries(
        Object.entries(prev).map(([channelId, members]) => [
          channelId,
          members.map((m) => (m.id === user.id ? user : m)),
        ])
      )
    );
  }

  async function handleSetServerIcon(serverId: string, file: File) {
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await fetch(`${getApiBase()}/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      if (!res.ok) throw new Error(await res.text());
      const uploaded = (await res.json()) as Array<{ id: string }>;
      const fileId = uploaded[0]?.id;
      if (!fileId) throw new Error("Upload failed");
      const updated = await api.setServerIcon(token, serverId, fileId);
      setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      toast("Server logo updated", "success");
    } catch (err) {
      toast(`Couldn't update server logo: ${err instanceof Error ? err.message : err}`, "error");
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
        onPickAccent={(hex) => {
          setAccent(hex);
          pushAppearance(token);
        }}
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
            homes={homes}
            activeHomeId={activeHomeId}
            onSwitchHome={onSwitchHome}
            onAddHome={onAddHome}
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
            idleUsers={idleUsers}
            activeVoiceChannelId={webrtc.channelId}
            voiceParticipantCount={webrtc.participants.length + (webrtc.channelId ? 1 : 0)}
            unread={unread}
            mentionChannels={mentions}
            myStatus={myStatus}
            onSetStatus={handleSetStatus}
            myActivity={!privacyMode && currentUser ? activities.get(currentUser.id) ?? null : null}
            onSetActivity={privacyMode ? undefined : updateActivity}
            canManageChannels={can(myPerms, PERM.MANAGE_CHANNELS)}
            canManageServer={can(myPerms, PERM.MANAGE_SERVER)}
            onOpenCategories={() => setShowCategories(true)}
            onSelectChannel={handleSelectChannel}
            onJoinVoice={handleJoinVoice}
            onCreateChannel={handleCreateChannel}
            onSetServerIcon={handleSetServerIcon}
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

      {servers.length === 0 && !selectedChannel ? (
        <NoServersYet
          onCreate={() => setShowCreateServer(true)}
          onFindPeople={() => setShowFindPeople(true)}
          onImportDiscord={() => setShowDiscordImport(true)}
        />
      ) : (
      <ChatPane
        channel={selectedChannel}
        messages={messages}
        dmTabs={dms}
        dmUsers={dmUsers}
        onSelectDmTab={handleSelectChannel}
        onNewDm={() => setShowFindPeople(true)}
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
        onSaveRecovery={() => { setSettingsTab("security"); setShowSettings(true); }}
        typingUsers={privacyMode ? [] : typing.typingIn(selectedChannel?.id ?? "")}
        onTyping={privacyMode ? undefined : sendTyping}
        onEditMessage={handleEditMessage}
        onDeleteMessage={handleDeleteMessage}
        onPinMessage={handlePinMessage}
        onForward={(msg) => setForwarding(msg)}
        onOpenSearch={selectedServer ? () => setShowSearch(true) : undefined}
        onOpenMembers={selectedServer ? () => setShowMembers(true) : undefined}
        onOpenDm={openDmWith}
        mentionables={selectedServer?.members ?? []}
        channelMembers={selectedServer?.members ?? undefined}
        onlineUserIds={onlineUsers}
        activityNotices={selectedChannel ? chatActivityNotices.filter((notice) => notice.channelId === selectedChannel.id) : []}
        currentUsername={currentUser.username}
        receipts={!privacyMode && selectedChannel ? receipts[selectedChannel.id] : undefined}
        watchSession={watchSession}
        onWatchControl={sendWatchControl}
        e2eEnabled={selectedChannel ? e2eChannels.has(selectedChannel.id) : false}
        groupMembers={selectedChannel ? groupMembers[selectedChannel.id] : undefined}
        onToggleE2e={
          selectedChannel?.channel_type === "dm" || selectedChannel?.channel_type === "group_dm"
            ? () => toggleE2e(selectedChannel.id)
            : undefined
        }
        onRequestSafetyNumber={
          selectedChannel?.channel_type === "dm"
            ? async () => {
                const peer = dmPeerId(selectedChannel.id);
                const me = currentUser?.id;
                return peer && me ? safetyNumber(token, me, peer) : null;
              }
            : undefined
        }
        e2eTrust={e2eTrust}
        onMarkVerified={
          selectedChannel?.channel_type === "dm"
            ? () => {
                const peer = dmPeerId(selectedChannel.id);
                if (peer) markVerified(peer);
              }
            : undefined
        }
        onDismissKeyChange={
          selectedChannel?.channel_type === "dm"
            ? () => {
                const peer = dmPeerId(selectedChannel.id);
                if (peer) acknowledgeIdentityChange(peer);
              }
            : undefined
        }
        onSetDisappearing={
          selectedChannel
            ? async (seconds) => {
                try {
                  await api.setDisappearing(token, selectedChannel.id, seconds);
                } catch {
                  toast("Couldn't update disappearing messages.");
                }
              }
            : undefined
        }
      />
      )}

      {/* Voice / video / screen-share call overlay. A WebRTC throw degrades to a
          small fallback instead of white-screening the whole app. */}
      <ErrorBoundary label="Voice call" onReset={() => webrtc.hangUp()}>
        <CallOverlay
          webrtc={webrtc}
          currentUser={currentUser}
          channelName={voiceChannel?.name ?? "Voice"}
        />
      </ErrorBoundary>

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

      {/* Local/admin Discord import from a Discrawl SQLite archive. */}
      {showDiscordImport && (
        <DiscordImportModal
          token={token}
          onImported={(server) => {
            enterServer(server);
            toast(`Imported ${server.name} from Discord.`, "success");
          }}
          onClose={() => setShowDiscordImport(false)}
        />
      )}

      {/* Invite-people modal — generates a shareable link for the open server */}
      {showInvite && selectedServer && (
        <InviteModal
          token={token}
          serverId={selectedServer.id}
          serverName={selectedServer.name}
          serverIconUrl={selectedServer.icon_url}
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
          idleUsers={idleUsers}
          activities={activities}
          voiceMembers={voiceMembers}
          onJoinVoice={joinVoiceById}
          onOpenDm={openDmWith}
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
          initialTab={settingsTab}
          privacyPrefs={privacyPrefs}
          onPrivacyPrefsChange={updatePrivacyPrefs}
          onClose={() => { setShowSettings(false); setSettingsTab("appearance"); }}
          onToast={toast}
          onCurrentUserUpdate={handleCurrentUserUpdate}
        />
      )}
    </div>
  );
}
