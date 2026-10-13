import "./index.css";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, useSyncExternalStore, type FormEvent } from "react";
import { api, getApiBase, getFileBase, setServerOrigin } from "./api";
import { Gateway } from "./gateway";
import { AuthScreen } from "./components/AuthScreen";
import { ModalShell } from "./components/ModalShell";
import { ServerSidebar } from "./components/ServerSidebar";
import { ChannelSidebar } from "./components/ChannelSidebar";
import { ChatPane, type ChatActivityNotice } from "./components/ChatPane";
import { ToastStack } from "./components/ToastStack";
import { SettingsModal, type Tab } from "./components/settings/SettingsModal";
import { CommandPalette, type CommandAction } from "./components/CommandPalette";
import { CallOverlay } from "./components/CallOverlay";
import { IncomingCallCard } from "./components/IncomingCallCard";
import { callCountsAsUnread, nextRings, type IncomingRing } from "./lib/dmCall";
import { startRingtone } from "./lib/ringtone";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { BootSplash } from "./components/BootSplash";
import { Onboarding } from "./components/Onboarding";
import { NoServersYet } from "./components/NoServersYet";
import { CreateServerModal } from "./components/CreateServerModal";
import { DiscordImportModal } from "./components/DiscordImportModal";
import { InviteAccept } from "./components/InviteAccept";
import { InviteModal } from "./components/InviteModal";
import { PrivateDmLinkAccept } from "./components/PrivateDmLinkAccept";
import { PrivateDmLinkModal } from "./components/PrivateDmLinkModal";
import { InstantServersModal } from "./components/InstantServersModal";
import { FindPeopleModal } from "./components/FindPeopleModal";
import { SearchModal, type SearchHit } from "./components/SearchModal";
import { MembersModal } from "./components/MembersModal";
import { RolesModal } from "./components/RolesModal";
import { EventsModal } from "./components/EventsModal";
import { SavedModal } from "./components/SavedModal";
import { CategoriesModal } from "./components/CategoriesModal";
import { ForwardModal } from "./components/ForwardModal";
import { PERM, can } from "./permissions";
import { NotificationSettingsDialog, type NotificationSettingsTarget } from "./components/NotificationSettingsDialog";
import { WebhooksDialog, type WebhookApi } from "./components/WebhooksDialog";
import { ModerationQueueModal } from "./components/moderation/ModerationQueueModal";
import { SlowmodeDialog } from "./components/moderation/SlowmodeDialog";
import { InvitesDialog } from "./components/moderation/InvitesDialog";
import { BansDialog } from "./components/moderation/BansDialog";
import { mentionsMe, notificationTitle } from "./lib/messageNotify";
import { loadSoundPrefs, playSound, shouldPlaySound } from "./lib/notificationSounds";
import { fileUrlOn } from "./lib/fileUrl";
import {
  isMuted,
  messageAlert,
  nextMuteExpiry,
  settingKey,
  settingsFromList,
  unreadFor,
  withSetting,
  type NotificationSettings,
} from "./lib/notificationSettings";
import { notify, ensureNotificationPermission, initDeepLinks, claimNotification, isDesktop } from "./lib/desktop";
import { parseSharedLink, type SharedLink } from "./lib/inviteLinks";
import { isOhiyoHome, readHomeInput } from "./lib/homeInput";
import { addToOutbox, removeFromOutbox, setOutboxState, outboxForChannel, pendingFailedOutbox, reconcileStalePending } from "./lib/outbox";
import { isActivationDismissed, loadActivation, markActivation, setActivationDismissed, type ActivationState } from "./lib/activation";
import { useWebRTC } from "./hooks/useWebRTC";
import { useWebRTCLiveKit } from "./hooks/useWebRTCLiveKit";
import { useVoiceControls } from "./hooks/useVoiceControls";
import { myKeyPair, deriveSharedKey, isEncrypted } from "./lib/e2e";
import { initSignal, encryptFor, decryptFrom, deviceId, isSignalCiphertext, parseSignalCiphertextHeader, refreshContactDevices, safetyNumber, safetyNumberKeySet } from "./lib/signal";
import { retryRetiredDevice } from "./lib/retiredDevice";
import { acknowledgeNewDevices, forgetDevices, newDevices, onNewDevicesChange, reconcileOwnDevices, type NewDevice } from "./lib/deviceWatch";
import { notMe } from "./lib/notMe";
import {
  onIdentityChange,
  trustState,
  markVerified,
  acknowledgeIdentityChange,
  type TrustState,
} from "./lib/identityTrust";
import { cachePlaintext, getCachedPlaintext, removeCachedPlaintext, sweepPlaintextCache } from "./lib/e2eCache";
import { afterDecryptAttempt, withOwnPlaintext } from "./lib/ownEcho";
import { configureRecoveryCoverageScope, coverageForMessage, recordGroupSenderKeyMessage, recordSignalMessage } from "./lib/recoveryCoverage";
import {
  groupEncrypt,
  groupDecrypt,
  isGroupCiphertext,
  parseGroupCiphertextHeader,
  buildDistribution,
  installDistribution,
  setGroupEpoch,
} from "./lib/senderKeys";
import { formatDuration, messageExpiry } from "./lib/disappearing";
import { slowmodeLabel } from "./lib/moderation";
import { packEncryptedMessagePlaintext, unpackEncryptedMessagePlaintext, type EncryptedAttachmentMeta } from "./lib/encryptedPayload";
import { createDistributionTracker, editBlockReason, encryptOutgoing, EncryptedSendError, forwardBlockReason, outgoingWire } from "./lib/encryptedSend";
import { isWellFormedEnvelope, resolveDmPeer, shouldEnterEncryptedMode, shouldRecordRecoveryInventory, withoutServerChannels } from "./lib/e2eMode";
import { renewWebPush } from "./lib/push";
import { catchUpMessages } from "./lib/catchUp";
import { GONE_PEER, dmsWith, dmsWithNoPeer, withoutAuthor } from "./lib/deletedAccounts";
import { padMessagePlaintext, unpadMessagePlaintext } from "./lib/messagePadding";
import { decryptEach } from "./lib/decryptEach";
import { getVaultStore, initVaultBackend, resetVaultAndRestart, restartApp } from "./lib/tauriVault";
import { parseVaultLocked, type VaultLocked } from "./lib/vaultLock";
import { VaultLockedScreen } from "./components/VaultLockedScreen";
import { VaultUnlocking } from "./components/VaultUnlocking";
import { SignOutDialog } from "./components/SignOutDialog";
import { signInRemovesLocalDataNow, signOutRemovesLocalDataNow } from "./lib/signOut";
import { clearDeletedAccountData, clearLocalMessageData } from "./lib/logoutCleanup";
import { onPlaintextCacheEvicted, saveEncryptedChannels } from "./lib/storageQuota";
import { uploadOne } from "./lib/uploadOne";
import { dropDraftsEnteringEncryptedMode, forgetAllDrafts } from "./lib/drafts";
import { firstUnreadId } from "./lib/unreadMarker";
import { apiStatus, badRequestMessage, deviceLimitMessage, moderationRefusal } from "./lib/apiErrors";
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
import { onLocalClock } from "./lib/watchSync";
import { VOICE_UNAVAILABLE, callEnvironment, refusesCall } from "./lib/voiceSupport";
import { arrivalInOpenChat, isLookingAt, lastRealMessageId } from "./lib/attention";
import { unreadTotal, withoutUnread } from "./lib/unreadTotal";
import { availabilityFrom, offersInstantServers, type InstantServersAvailability } from "./lib/instantServers";
import { useDesktopShell } from "./hooks/useDesktopShell";
import { useAppUpdate } from "./hooks/useAppUpdate";
import { UpdateBar } from "./components/UpdateBar";
import { SignedOutUpdates } from "./components/SignedOutUpdates";
import { NewDeviceAlert } from "./components/NewDeviceAlert";
import { ThreadPanel } from "./components/ThreadPanel";
import { StartThreadDialog } from "./components/StartThreadDialog";
import { ThreadListDialog } from "./components/ThreadListDialog";
import {
  canManageThread,
  canStartThread,
  defaultThreadName,
  isArchived,
  removeThread,
  threadAlert,
  threadsByMessage,
  upsertThread,
  withFollow,
  type ThreadSummary,
} from "./lib/threads";
import { DeleteThreadDialog } from "./components/DeleteThreadDialog";
import { setSignInNotice } from "./lib/sessionNotice";
import { TWO_FACTOR_EVENT, shouldAnnounceTwoFactorChange, twoFactorChangedHereAt } from "./lib/twoFactor";
import {
  loadActiveHomeId,
  loadHomes,
  saveActiveHomeId,
  saveHomes,
  setHomeLastUser,
  setHomeToken,
  upsertHome,
  type OhiyoHome,
  takeRetiredHomeDropped,
} from "./lib/homes";
import { MentionsInbox, PhoneTabBar, type PhoneTab } from "./components/PhoneTabBar";
import { useSwipeNav } from "./hooks/useSwipeNav";
import type { Channel, Message, PublicUser, ServerWithChannels, ServerEmoji } from "./api";
import type { PluginAPI } from "./plugins/api";
import type { GatewayEvent, ConnectionStatus, Activity, WatchSession } from "./gateway";

type VoiceSidebarParticipant = {
  user_id: string;
  user: PublicUser;
  muted: boolean;
  video: boolean;
  screen: boolean;
  listenOnly: boolean;
  deafened?: boolean;
  isSelf?: boolean;
};

// Boot the theme + personal accent from localStorage immediately (warm first paint).
applyActiveAppearance();

/** One stable empty thread list, so a channel without threads doesn't re-render its rows. */
const NO_THREADS: ThreadSummary[] = [];
/** Jumping to an older message pages back this many messages at a time, at most this often. */
const JUMP_PAGE = 100;
const JUMP_PAGES = 10;
/** Mark-as-read asks the server about at most this many chats at a time (its limit). */
const MARK_READ_BATCH = 200;
/** An incoming call's card stays at least this long, plus this grace, if its stop is lost. */
const RING_FALLBACK_MIN_SECS = 10;
const RING_FALLBACK_GRACE_SECS = 5;
/** Seats in a DM or group-chat call (the server's limit, for the "full" message). */
const DM_CALL_SEATS = 10;

// On logout: drop decrypted plaintext, the outbox and every draft from localStorage and
// (desktop) the vault. Identity and session keys stay.
function clearSignedOutMessageData(): void {
  try {
    const browser = {
      keys: () => Object.keys(localStorage),
      removeMany: (keys: string[]) => keys.forEach((k) => localStorage.removeItem(k)),
    };
    const vault = getVaultStore();
    clearLocalMessageData(vault ? [browser, vault] : [browser]);
    forgetAllDrafts();
  } catch {
    /* storage disabled — nothing was persisted to clear */
  }
}

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
  // An invite or private DM link pasted into "Add an Ohiyo home": opened on this home, once
  // someone is signed in to it.
  const [pendingLink, setPendingLink] = useState<SharedLink | null>(null);
  const [authScreenKey, setAuthScreenKey] = useState(0);
  // Asking before signing out of the last signed-in home (it removes local message data).
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  // Desktop: the session token lives in the encrypted vault, which hydrates
  // asynchronously. Until it's ready we can't tell "logged out" from "token still
  // sealed", so the UI is gated on this flag. Web has no vault → ready immediately.
  const [vaultReady, setVaultReady] = useState(() => !isDesktop());
  // Desktop: why the vault couldn't be unlocked (keychain or sealed-file failure), if so.
  const [vaultLocked, setVaultLocked] = useState<VaultLocked | null>(null);

  useEffect(() => {
    if (activeHome) setServerOrigin(activeHome.url);
  }, [activeHome]);

  // Hydrate the desktop vault once at startup, then re-read homes so each home's token
  // resolves from the now-warm vault (it was absent from the synchronous first load).
  // `.finally` guarantees we never get stuck on the splash if the vault is unavailable.
  useEffect(() => {
    if (!isDesktop()) return; // web: tokens already came from localStorage synchronously
    let cancelled = false;
    void initVaultBackend()
      .catch((err: unknown) => {
        if (!cancelled) setVaultLocked(parseVaultLocked(err) ?? { kind: "keychain", reason: String(err) });
      })
      .finally(() => {
        if (cancelled) return;
        setHomes(loadHomes());
        setVaultReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The hosted backend moved with a fresh database. If loading dropped the home stored
  // for its old address and nothing else is signed in, the cached messages, outbox and
  // drafts belong to an account that no longer exists: remove them.
  useEffect(() => {
    if (!vaultReady) return;
    if (takeRetiredHomeDropped() && !loadHomes().some((h) => h.token)) clearSignedOutMessageData();
  }, [vaultReady]);

  // Set by signOut when the sign-out removes local data. Clearing waits for the
  // signed-out render to commit: the chat saves its draft as it unmounts, and effects run
  // after every unmount cleanup.
  const logoutCleanupPendingRef = useRef(false);
  useEffect(() => {
    if (!logoutCleanupPendingRef.current) return;
    logoutCleanupPendingRef.current = false;
    clearSignedOutMessageData();
  }, [token]);

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

  // Persist the token to the active home so sessions survive reloads per server, and
  // remember who signed in. A different user than the one who last used this home here,
  // with no other home signed in, must not see the previous account's readable data:
  // remove it now, before anything loads, flushes from the outbox or reads the cache.
  function handleAuth(newToken: string, userId: string) {
    if (!activeHome) return;
    if (signInRemovesLocalDataNow(activeHome.id, userId)) clearSignedOutMessageData();
    persistHomes(setHomeLastUser(setHomeToken(homes, activeHome.id, newToken), activeHome.id, userId));
  }

  // Ready confirmed who this session belongs to: remember it (homes read fresh, so other
  // homes' tokens are written back as they are stored).
  function rememberHomeUser(userId: string) {
    if (!activeHome || activeHome.lastUserId === userId) return;
    const next = setHomeLastUser(loadHomes(), activeHome.id, userId);
    setHomes(next);
    saveHomes(next);
  }

  function signOut(removeLocalData: boolean) {
    if (!activeHome) return;
    logoutCleanupPendingRef.current = removeLocalData;
    persistHomes(setHomeToken(loadHomes(), activeHome.id, null));
  }

  // The sidebar's sign-out (the user chose to leave). Signing out of the last signed-in
  // home removes this device's readable encrypted history, so it asks first; with another
  // home still signed in (as stored now, so other tabs count), nothing is removed.
  function handleLogout() {
    if (!activeHome) return;
    if (signOutRemovesLocalDataNow(activeHome.id)) setConfirmSignOut(true);
    else signOut(false);
  }

  // The account was deleted on the server. Sign this device out. When no other signed-in
  // home shares this device's keys, its messages and encryption keys go too: they belong
  // to an account that no longer exists.
  function handleAccountDeleted(userId: string) {
    if (!activeHome) return;
    const lastHome = signOutRemovesLocalDataNow(activeHome.id);
    if (lastHome) {
      try {
        const browser = {
          keys: () => Object.keys(localStorage),
          removeMany: (keys: string[]) => keys.forEach((k) => localStorage.removeItem(k)),
        };
        const vault = getVaultStore();
        clearDeletedAccountData(vault ? [browser, vault] : [browser], userId);
      } catch {
        /* storage disabled — nothing was persisted to clear */
      }
    }
    setSignInNotice("Your account was deleted.");
    // signOut clears messages again once the chat has unmounted (it saves a draft then).
    signOut(lastHome);
  }

  // BootSplash's "Back to sign in": the session isn't working (expired after 30 days, or
  // revoked). Removes nothing; a different user signing in is handled in handleAuth.
  function handleBackToSignIn() {
    signOut(false);
  }

  if (!activeHome) return null;
  if (!vaultReady) {
    // Desktop only: a brief wait while the encrypted vault unlocks and the session token
    // hydrates, so an already-signed-in user never flashes the login screen.
    return <VaultUnlocking />;
  }
  if (vaultLocked !== null) {
    // Desktop only: don't start with an empty vault, which would replace the saved keys.
    return <VaultLockedScreen locked={vaultLocked} onTryAgain={restartApp} onReset={resetVaultAndRestart} />;
  }
  const addHomeModal = showAddHome ? (
    <AddHomeModal
      onAdd={(url) => {
        addHome(url);
        setShowAddHome(false);
      }}
      onOpenLink={(link) => {
        setPendingLink(link);
        setShowAddHome(false);
        if (!token) {
          // The sign-in screen reads its notice when it mounts: remount it to show this one.
          setSignInNotice(link.kind === "invite" ? "Sign in and the invite opens right after." : "Sign in and the private DM link opens right after.");
          setAuthScreenKey((k) => k + 1);
        }
      }}
      onClose={() => setShowAddHome(false)}
    />
  ) : null;
  if (!token) {
    return (
      <>
        <AuthScreen
          key={authScreenKey}
          home={activeHome}
          homes={homes}
          onAuth={handleAuth}
          onSwitchHome={setActiveHomeId}
          onAddHome={() => setShowAddHome(true)}
        />
        <SignedOutUpdates />
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
        onAddHomeUrl={addHome}
        onLogout={handleLogout}
        onBackToSignIn={handleBackToSignIn}
        onSessionUser={rememberHomeUser}
        onTokenChange={(next) => persistHomes(setHomeToken(loadHomes(), activeHome.id, next))}
        onAccountDeleted={handleAccountDeleted}
        pendingLink={pendingLink}
        onPendingLinkTaken={() => setPendingLink(null)}
      />
      {addHomeModal}
      {confirmSignOut && (
        <SignOutDialog
          onCancel={() => setConfirmSignOut(false)}
          onConfirm={() => {
            setConfirmSignOut(false);
            signOut(true);
          }}
        />
      )}
    </>
  );
}

function AddHomeModal({
  onAdd,
  onOpenLink,
  onClose,
}: {
  onAdd: (url: string) => void;
  /** An invite or private DM link was pasted: open it on the current home instead. */
  onOpenLink: (link: SharedLink) => void;
  onClose: () => void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const trimmed = url.trim();

  // Nothing changes until the address answers as an Ohiyo server: a wrong one used to become
  // the active home and leave the app on a sign-in screen that could reach nothing.
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!trimmed || checking) return;
    const input = readHomeInput(trimmed);
    if (input.kind === "link") {
      onOpenLink(input.link);
      return;
    }
    if (input.kind === "invalid") {
      setError("That doesn't look like an Ohiyo home address. Use https:// for normal homes, http://localhost for local homes, or http://…onion in Tor Browser.");
      return;
    }
    setError(null);
    setChecking(true);
    const reachable = await isOhiyoHome(input.url);
    setChecking(false);
    if (!reachable) {
      setError(`Couldn't reach an Ohiyo home at ${new URL(input.url).host}. Check the address and try again.`);
      return;
    }
    onAdd(input.url);
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
        A home is the server an Ohiyo account lives on. Paste its address to add another one. Got an invite to a
        space? That goes in Join a space, behind the + in your space list. In Tor Browser you can also add an
        <code className="mx-1 rounded px-1" style={{ background: "var(--bg-input)", color: "var(--text-secondary)" }}>http://…onion</code>
        home. The desktop app does not route through Tor by itself.
      </p>
      <form onSubmit={(e) => void submit(e)} className="mt-4 flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm font-semibold" style={{ color: "var(--text-primary)" }}>
          Home link
          <input
            value={url}
            onChange={(e) => { setUrl(e.target.value); setError(null); }}
            aria-invalid={error ? true : undefined}
            placeholder="https://your-ohiyo-home.example or http://yourhome.onion"
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
          <button type="submit" disabled={!trimmed || checking} className="kc-cta rounded-full px-4 py-2 text-sm" style={{ opacity: trimmed && !checking ? 1 : 0.6 }}>
            {checking ? "Checking…" : "Add home"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

const NO_NEW_DEVICES: NewDevice[] = [];

/** Longest wait between asks when a refused session's "who am I?" check can't reach the
 *  server (the waits start at 2 s and double). */
const SIGNED_OUT_RECHECK_MAX_MS = 30_000;

/** Read this account's devices and note any this device hasn't seen (deviceWatch). */
async function checkOwnDevices(token: string, userId: string): Promise<void> {
  try {
    const list = await api.listDevices(token);
    const activeAt = new Map(list.map((d) => [d.device_id, d.updated_at]));
    reconcileOwnDevices(userId, deviceId(), list.map((d) => d.device_id), undefined, activeAt);
  } catch {
    /* offline: the next sign-in or DeviceAdded checks again */
  }
}

function MainApp({
  token,
  homes,
  activeHomeId,
  onSwitchHome,
  onAddHome,
  onAddHomeUrl,
  onLogout,
  onBackToSignIn,
  onSessionUser,
  onTokenChange,
  onAccountDeleted,
  pendingLink,
  onPendingLinkTaken,
}: {
  token: string;
  homes: OhiyoHome[];
  activeHomeId: string;
  onSwitchHome: (id: string) => void;
  onAddHome: () => void;
  onAddHomeUrl: (url: string) => void;
  onLogout: () => void;
  /** BootSplash's way back when the session isn't working; removes nothing. */
  onBackToSignIn: () => void;
  /** Ready confirmed the session's user: the home remembers it. */
  onSessionUser: (userId: string) => void;
  /** The server issued a new token for this home (after a password change). */
  onTokenChange: (token: string) => void;
  /** The account was deleted on the server. */
  onAccountDeleted: (userId: string) => void;
  /** An invite or private DM link pasted into "Add an Ohiyo home", to open here. */
  pendingLink: SharedLink | null;
  onPendingLinkTaken: () => void;
}) {
  const { toasts, push: toast } = useToast();
  // A full localStorage removed the oldest decrypted messages to make room: say so once.
  useEffect(() => onPlaintextCacheEvicted((notice) => toast(notice)), [toast]);
  const [currentUser, setCurrentUser] = useState<PublicUser | null>(null);
  // Remember who uses this home on this device once Ready confirms it (a later sign-in by
  // someone else then clears the shared local message data first).
  const onSessionUserRef = useRef(onSessionUser);
  onSessionUserRef.current = onSessionUser;
  useEffect(() => {
    if (currentUser?.id) onSessionUserRef.current(currentUser.id);
  }, [currentUser?.id]);
  const [activation, setActivation] = useState<ActivationState>(() => loadActivation(null));
  const [activationDismissed, setActivationDismissedState] = useState(false);
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
  // A message to scroll to and mark once it is loaded (from a search result's Jump).
  const [focusMessage, setFocusMessage] = useState<{ id: string; seq: number; channelId: string } | null>(null);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [serverEmojis, setServerEmojis] = useState<ServerEmoji[]>([]);
  // Threads: each channel's list (busiest first), the one open beside the channel, the
  // message a new thread is being named from, and whether the channel's list is showing.
  const [threadsByParent, setThreadsByParent] = useState<Record<string, ThreadSummary[]>>({});
  const [openThread, setOpenThread] = useState<ThreadSummary | null>(null);
  const [threadFromMessage, setThreadFromMessage] = useState<Message | null>(null);
  const [showThreadList, setShowThreadList] = useState(false);
  // Threads you follow (they count as unread and notify like their channel), and the thread
  // being renamed or deleted.
  const [followedThreads, setFollowedThreads] = useState<ReadonlySet<string>>(() => new Set());
  const followedThreadsRef = useRef<ReadonlySet<string>>(followedThreads);
  followedThreadsRef.current = followedThreads;
  const openThreadRef = useRef<ThreadSummary | null>(null);
  openThreadRef.current = openThread;
  const [renamingThread, setRenamingThread] = useState<ThreadSummary | null>(null);
  const [deletingThread, setDeletingThread] = useState<ThreadSummary | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<Tab>("appearance");
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showCreateServer, setShowCreateServer] = useState(false);
  const [showDiscordImport, setShowDiscordImport] = useState(false);
  const [showInstantServers, setShowInstantServers] = useState(false);
  // Whether this home can make Instant Servers; the palette leaves them out where it can't.
  const [instantServers, setInstantServers] = useState<InstantServersAvailability>("unknown");
  useEffect(() => {
    let live = true;
    setInstantServers("unknown");
    api
      .instantServersAvailable(token)
      .then((body) => {
        if (live) setInstantServers(availabilityFrom(body));
      })
      .catch(() => {
        // An older or self-hosted home without the endpoint: keep the palette as it was.
      });
    return () => {
      live = false;
    };
  }, [token]);
  const [showInvite, setShowInvite] = useState(false);
  const [showPrivateDmLink, setShowPrivateDmLink] = useState(false);
  const [showFindPeople, setShowFindPeople] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [showRoles, setShowRoles] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [showCategories, setShowCategories] = useState(false);
  const [showModQueue, setShowModQueue] = useState(false);
  const [showInvites, setShowInvites] = useState(false);
  const [showBans, setShowBans] = useState(false);
  // The channel whose slowmode is being set.
  const [slowmodeFor, setSlowmodeFor] = useState<Channel | null>(null);
  // Members timed out in the selected space (for those who can time out): user → until.
  const [memberTimeouts, setMemberTimeouts] = useState<ReadonlyMap<string, number>>(new Map());
  const [blockedUserIds, setBlockedUserIds] = useState<Set<string>>(new Set());
  // maybeNotify runs from the gateway handler registered once per token, so it reads the
  // current blocked list through this ref, not the first render's.
  const blockedUserIdsRef = useRef(blockedUserIds);
  blockedUserIdsRef.current = blockedUserIds;
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [eventsRefresh, setEventsRefresh] = useState(0);
  const [myPerms, setMyPerms] = useState(0);
  // When your time out in the selected space ends (unix seconds), if you're timed out.
  const [myTimeoutUntil, setMyTimeoutUntil] = useState<number | null>(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Phones: the Mentions tab of the drawer's tab bar, and the space the Home tab goes back to.
  const [showMentionsInbox, setShowMentionsInbox] = useState(false);
  const lastSpaceIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedServerId) lastSpaceIdRef.current = selectedServerId;
  }, [selectedServerId]);
  // Phones: swipe right for the drawer, left for the member list (hooks/useSwipeNav.ts).
  useSwipeNav({
    open: mobileNavOpen ? "nav" : showMembers ? "members" : "none",
    canOpenMembers: selectedServerId !== null,
    onChange: (panel) => {
      setMobileNavOpen(panel === "nav");
      setShowMembers(panel === "members");
    },
  });
  const [dmUsers, setDmUsers] = useState<Record<string, PublicUser>>({});
  const [inviteCode, setInviteCode] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("invite")
  );
  const [privateDmToken, setPrivateDmToken] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("dm")
  );
  useEffect(() => {
    if (!pendingLink) return;
    if (pendingLink.kind === "invite") setInviteCode(pendingLink.code);
    else setPrivateDmToken(pendingLink.token);
    onPendingLinkTaken();
  }, [pendingLink, onPendingLinkTaken]);
  // Seeded per-account from `kc:welcomed:<userId>` once we know who logged in (in the
  // Ready handler) — so a different account on a shared device isn't treated as welcomed.
  const [welcomed, setWelcomed] = useState(false);
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [mentions, setMentions] = useState<Set<string>>(new Set());
  const unreadRef = useRef(unread);
  unreadRef.current = unread;
  const mentionsRef = useRef(mentions);
  mentionsRef.current = mentions;
  // When the newest message this device has heard of in each chat was sent (for read marks
  // from your other devices).
  const newestMessageAtRef = useRef(new Map<string, number>());
  // The chat you just opened had this many unread messages: the "New messages" line and the
  // catch-up bar, until you leave, send, press Esc or Mark as read.
  const [unreadMarker, setUnreadMarker] = useState<{ channelId: string; count: number } | null>(null);
  // Notification settings (a space's level, mutes), synced across the account's devices.
  const [notifSettings, setNotifSettings] = useState<NotificationSettings>({});
  const notifSettingsRef = useRef(notifSettings);
  notifSettingsRef.current = notifSettings;
  const [notifTarget, setNotifTarget] = useState<NotificationSettingsTarget | null>(null);
  // The space's incoming webhooks (space menu → Webhooks, for people who manage channels).
  const [showWebhooks, setShowWebhooks] = useState(false);
  const webhookApi = useMemo<WebhookApi>(
    () => ({
      list: (channelId) => api.listWebhooks(token, channelId),
      create: (channelId, name) => api.createWebhook(token, channelId, name),
      rename: (id, name) => api.updateWebhook(token, id, { name }),
      renew: (id) => api.renewWebhook(token, id),
      remove: (id) => api.deleteWebhook(token, id),
      setPicture: async (id, file) => {
        const { id: fileId } = await uploadOne(getApiBase(), token, file);
        return api.updateWebhook(token, id, { avatar_file_id: fileId });
      },
    }),
    [token],
  );
  // Render again when the next mute ends, so its chat counts and notifies again on time.
  const [muteTick, setMuteTick] = useState(0);
  useEffect(() => {
    const next = nextMuteExpiry(notifSettings, Math.floor(Date.now() / 1000));
    if (next === null) return;
    // Capped at a day: a timer can't wait much longer than three weeks, and mutes last a year.
    const wait = Math.min(86_400_000, Math.max(1000, next * 1000 - Date.now() + 500));
    const timer = window.setTimeout(() => setMuteTick((n) => n + 1), wait);
    return () => window.clearTimeout(timer);
  }, [notifSettings, muteTick]);
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
  useEffect(() => {
    const userId = currentUser?.id;
    setActivation(loadActivation(userId));
    setActivationDismissedState(isActivationDismissed(userId));
    if (userId) setActivation(markActivation(userId, "account"));
    const refresh = () => {
      setActivation(loadActivation(userId));
      setActivationDismissedState(isActivationDismissed(userId));
    };
    window.addEventListener("ohiyo:activation", refresh);
    window.addEventListener("ohiyo:activation-dismissed", refresh);
    return () => {
      window.removeEventListener("ohiyo:activation", refresh);
      window.removeEventListener("ohiyo:activation-dismissed", refresh);
    };
  }, [currentUser?.id]);

  const completeActivation = useCallback((milestone: keyof ActivationState) => {
    setActivation(markActivation(currentUserRef.current?.id ?? currentUser?.id, milestone));
  }, [currentUser?.id]);

  const dismissActivationChecklist = useCallback(() => {
    const userId = currentUserRef.current?.id ?? currentUser?.id;
    setActivationDismissed(userId, true);
    setActivationDismissedState(true);
  }, [currentUser?.id]);

  const [onlineUsers, setOnlineUsers] = useState<Set<string>>(new Set());
  // 1:1 chats whose other person deleted their account: no one to reply to.
  const [goneDms, setGoneDms] = useState<ReadonlySet<string>>(new Set());
  const [idleUsers, setIdleUsers] = useState<Set<string>>(new Set());
  const [activities, setActivities] = useState<Map<string, Activity>>(new Map());
  const [watchSession, setWatchSession] = useState<WatchSession | null>(null);
  const [voiceMembers, setVoiceMembers] = useState<Map<string, string>>(new Map()); // userId → voice channelId
  const [voiceParticipantsByChannel, setVoiceParticipantsByChannel] = useState<Map<string, Map<string, VoiceSidebarParticipant>>>(new Map());
  const [chatActivityNotices, setChatActivityNotices] = useState<Array<ChatActivityNotice & { channelId: string }>>([]);
  const [e2eChannels, setE2eChannels] = useState<Set<string>>(() => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem("kc:e2e-channels") || "[]"));
    } catch {
      return new Set<string>();
    }
  });
  const selectedChannelRef = useRef<Channel | null>(null);
  // Every thread this app has heard of. A thread's replies arrive as ordinary messages; this
  // is how they're told apart (the server announces a thread before its first reply).
  const threadIdsRef = useRef<Set<string>>(new Set());
  // thread id → the channel it hangs off, so a thread follows its channel's notification settings.
  const threadParentRef = useRef<Map<string, string>>(new Map());
  const selectedServerIdRef = useRef<string | null>(null);
  // Last message id we've acked per channel — dedupes redundant read receipts.
  const lastAckRef = useRef<Record<string, string>>({});
  const didAutoSelectRef = useRef(false);
  // Set by the first Ready: any later one follows a time this device was cut off.
  const sawReadyRef = useRef(false);
  const notifyAskedRef = useRef(false);
  const handleSelectChannelRef = useRef<(channel: Channel) => void>(() => {});
  const currentUserRef = useRef<PublicUser | null>(null);
  // E2E: mirror DM state into refs so the stable send/decrypt callbacks read live values.
  const e2eChannelsRef = useRef(e2eChannels);
  e2eChannelsRef.current = e2eChannels;
  const dmUsersRef = useRef(dmUsers);
  dmUsersRef.current = dmUsers;
  const dmsRef = useRef(dms);
  dmsRef.current = dms;
  const dmKeyCacheRef = useRef<Map<string, CryptoKey>>(new Map());
  const dmPeerRef = useRef<Map<string, string>>(new Map()); // channelId → peer userId (from the participant list)
  const serversRef = useRef<ServerWithChannels[]>([]);
  const gatewayRef = useRef<Gateway | null>(null);
  const privacyModeRef = useRef(privacyMode);
  privacyModeRef.current = privacyMode;

  function messageFromDecryptedPlaintext(message: Message, plain: string): Message {
    // Attachments not on this home's /files/<id> are dropped (the URL is sender-controlled).
    const unpacked = unpackEncryptedMessagePlaintext(plain, getFileBase());
    return {
      ...message,
      content: unpacked.text,
      attachments: unpacked.attachments ?? message.attachments,
      _encrypted: true,
    };
  }

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
      // Drop decrypted plaintext that has passed its expiry, including entries a restore
      // wrote without indexing, before anything reads the cache.
      sweepPlaintextCache();
      // Finish removing a device id a key restore replaced, if that failed at the time.
      void retryRetiredDevice((id) => api.removeDevice(token, id), currentUser.id, deviceId);
      // A device added to this account while this one was closed is announced now.
      void checkOwnDevices(token, currentUser.id);
      // A push subscription belongs to the session that registered it; register this
      // browser's again for this one, so its notifications carry on after a sign-in.
      void renewWebPush(token);
      myKeyPair()
        .then((kp) => {
          if (alive) void api.publishKey(token, JSON.stringify(kp.publicJwk));
        })
        .catch(() => {});
      // Generate + publish Signal prekeys (forward-secret X3DH sessions). Idempotent;
      // makes every signed-in user Signal-capable. The DM-flow switch builds on this.
      // An account at its device limit gets told where to remove one.
      void initSignal(token).catch((err: unknown) => {
        const tooManyDevices = deviceLimitMessage(err);
        if (tooManyDevices === null) throw err;
        if (alive) toast(tooManyDevices, "error");
      });
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
    sendMeta: (cid: string, muted: boolean, video: boolean, screen: boolean, listenOnly: boolean, deafened: boolean) =>
      gatewayRef.current?.send({ t: "VoiceMeta", d: { channel_id: cid, muted, video, screen, listen_only: listenOnly, deafened } }),
    sendSignal: (to: string, kind: string, payload: string) =>
      gatewayRef.current?.send({
        t: "Signal",
        d: { to, channel_id: activeVoiceRef.current ?? "", kind, payload },
      }),
  }).current;
  const mesh = useWebRTC(webrtcCallbacks);
  const sfu = useWebRTCLiveKit(webrtcCallbacks, token);
  const webrtc = liveKitEnabled ? sfu : mesh;
  // Push to talk, input sensitivity and the mute/deafen shortcuts, from this device's settings.
  const voiceControls = useVoiceControls(webrtc);
  // Calls in DMs and group chats: the calls ringing for you, and the chat you're calling
  // while nobody has answered yet (the call screen says "Ringing…").
  const [rings, setRings] = useState<IncomingRing[]>([]);
  const [outgoingCall, setOutgoingCall] = useState<string | null>(null);
  const outgoingCallRef = useRef(outgoingCall);
  outgoingCallRef.current = outgoingCall;

  // ── Desktop shell: the tray, the dock badge, and a window that can sit hidden ──
  // Unread numbers after notification settings: the sidebar shows `shownUnread`; the Dock,
  // tray and tab title count `countedUnread` (muted chats and "only @mentions" spaces don't).
  const nowSec = Math.floor(Date.now() / 1000);
  const channelServer = new Map<string, string>();
  for (const s of servers) for (const c of s.channels) channelServer.set(c.id, s.id);
  const { shown: shownUnread, counted: countedUnread } = unreadFor(
    unread,
    mentions,
    notifSettings,
    (id) => channelServer.get(id) ?? null,
    nowSec,
    (id) => threadParentRef.current.get(id),
  );
  const totalUnread = unreadTotal(countedUnread);
  // Chats that look muted in the sidebar: muted themselves, or in a muted space.
  const mutedChannelIds = new Set<string>();
  for (const s of servers) {
    const spaceMuted = isMuted(notifSettings[settingKey("server", s.id)], nowSec);
    for (const c of s.channels) {
      if (spaceMuted || isMuted(notifSettings[settingKey("channel", c.id)], nowSec)) mutedChannelIds.add(c.id);
    }
  }
  for (const d of dms) if (isMuted(notifSettings[settingKey("channel", d.id)], nowSec)) mutedChannelIds.add(d.id);
  // A call ringing for you plays the ringtone, unless its chat is muted (the card still shows,
  // quietly). A ring whose stop never came (a dropped connection) goes when its time is up.
  const ringAudible = rings.some((r) => !mutedChannelIds.has(r.channelId));
  useEffect(() => {
    if (!ringAudible) return;
    return startRingtone();
  }, [ringAudible]);
  const hasRings = rings.length > 0;
  useEffect(() => {
    if (!hasRings) return;
    const timer = window.setInterval(() => {
      setRings((prev) => nextRings(prev, { type: "tick", now: Math.floor(Date.now() / 1000) }));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hasRings]);
  // A window hidden in the tray is never "looking at" a chat: messages there notify and
  // count as unread, and are marked read when the window comes back.
  const windowHiddenRef = useRef(false);
  const lastMessageIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    lastMessageIdRef.current = lastRealMessageId(messages);
  }, [messages]);
  const appUpdate = useAppUpdate({ isSignedIn: currentUser !== null, onMessage: toast });
  // Threads: load the open channel's list, and close a thread whose channel is no longer open.
  const selectedChannelId = selectedChannel?.id ?? null;
  const selectedChannelThreadable = selectedChannel ? canStartThread(selectedChannel) : false;
  useEffect(() => {
    setOpenThread((prev) => (prev && prev.parent_id === selectedChannelId ? prev : null));
    setShowThreadList(false);
    if (!selectedChannelId || !selectedChannelThreadable) return;
    let live = true;
    api
      .listThreads(token, selectedChannelId)
      .then((list) => {
        if (!live) return;
        for (const t of list) {
          threadIdsRef.current.add(t.id);
          threadParentRef.current.set(t.id, t.parent_id ?? selectedChannelId);
        }
        setThreadsByParent((prev) => ({ ...prev, [selectedChannelId]: list }));
        // The list says which of them you follow (a newer server only).
        setFollowedThreads((prev) =>
          list.reduce((set, t) => (t.following === undefined ? set : withFollow(set, t.id, t.following)), prev)
        );
      })
      .catch(() => {
        // The channel still works without its thread list; the next ThreadUpdate fills it in.
      });
    return () => {
      live = false;
    };
  }, [token, selectedChannelId, selectedChannelThreadable]);
  const channelThreads = (selectedChannelId && threadsByParent[selectedChannelId]) || NO_THREADS;
  // New replies in the channel's threads you follow (after notification settings), for the
  // line under each thread's message and the Threads list.
  const channelThreadUnread = new Map<string, number>();
  for (const t of channelThreads) {
    const n = shownUnread[t.id];
    if (n && followedThreads.has(t.id)) channelThreadUnread.set(t.id, n);
  }
  // Lets the open thread listen to the gateway for its own messages.
  const subscribeGateway = useCallback(
    (handler: (event: GatewayEvent) => void) => gatewayRef.current?.on(handler) ?? (() => {}),
    []
  );
  const threadByMessage = useMemo(() => threadsByMessage(channelThreads), [channelThreads]);

  useDesktopShell({
    unread: totalUnread,
    inCall: webrtc.channelId !== null,
    onLeaveCall: () => {
      if (webrtc.channelId !== null) webrtc.hangUp();
    },
    onCheckUpdates: () => void appUpdate.check(true),
    onWindowHidden: (hidden) => {
      windowHiddenRef.current = hidden;
      const open = selectedChannelRef.current;
      if (hidden || !open) return;
      // Back on screen: what arrived in the open chat while hidden is now read.
      sendAck(open.id, lastMessageIdRef.current);
      setUnread((prev) => withoutUnread(prev, open.id));
    },
  });
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
    configureRecoveryCoverageScope(activeHomeId, currentUser?.id ?? null);
  }, [activeHomeId, currentUser]);

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
    document.title = totalUnread > 0 ? `(${totalUnread}) Ohiyo` : "Ohiyo";
  }, [totalUnread]);

  useEffect(() => {
    if (!currentUser?.id) return;
    let alive = true;
    api.listBlocks(token)
      .then((blocks) => alive && setBlockedUserIds(new Set(blocks.map((b) => b.id))))
      .catch(() => alive && setBlockedUserIds(new Set()));
    return () => { alive = false; };
  }, [currentUser?.id, token]);

  // My effective permissions for the selected server (gates moderation UI).
  useEffect(() => {
    selectedServerIdRef.current = selectedServerId;
    if (!selectedServerId) { setMyPerms(0); setMyTimeoutUntil(null); return; }
    let alive = true;
    api.getMyPermissions(token, selectedServerId)
      .then((p) => {
        if (!alive) return;
        setMyPerms(p.permissions);
        setMyTimeoutUntil(p.timed_out_until ?? null);
      })
      .catch(() => {
        if (!alive) return;
        setMyPerms(0);
        setMyTimeoutUntil(null);
      });
    return () => { alive = false; };
  }, [selectedServerId, token]);
  useEffect(() => { serversRef.current = servers; }, [servers]);

  // Who is timed out, for the member list of someone who can time people out.
  const canTimeoutMembers = can(myPerms, PERM.MODERATE_MEMBERS);
  useEffect(() => {
    setMemberTimeouts(new Map());
    if (!showMembers || !selectedServerId || !canTimeoutMembers) return;
    let alive = true;
    api
      .listTimeouts(token, selectedServerId)
      .then((rows) => alive && setMemberTimeouts(new Map(rows.map((t): [string, number] => [t.user_id, t.until]))))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [showMembers, selectedServerId, canTimeoutMembers, token]);

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
      senderKeyDistributionRef.current.forget(channelId);
      // A failure here resurfaces on the next send, which awaits a fresh attempt.
      if (e2eChannelsRef.current.has(channelId)) distributeMySenderKey(channelId).catch(() => {});
    });
  }

  // Who a 1:1 DM is with, for a chat that arrived live (Ready names the rest), so it has a
  // name in the list rather than "Direct Message".
  async function nameDm(channelId: string) {
    try {
      const people = await api.listRecipients(token, channelId);
      const peer = people.length === 2 ? people.find((p) => p.id !== currentUserRef.current?.id) : undefined;
      if (!peer) return;
      dmPeerRef.current.set(channelId, peer.id);
      setDmUsers((prev) => (prev[channelId] ? prev : { ...prev, [channelId]: peer }));
    } catch {
      // Offline or no longer allowed in: the next Ready names it.
    }
  }

  // After a reconnect, or a fresh Ready because this connection fell behind, fetch what
  // the open chat missed while this device was cut off. Quietly: no spinner, and older
  // history on screen stays. It's marked read only if the window is in view.
  async function catchUpOpenChat() {
    const channel = selectedChannelRef.current;
    if (!channel) return;
    try {
      const latest = await api.listMessages(token, channel.id);
      if (selectedChannelRef.current?.id !== channel.id) return;
      const shown = await decryptMessages(channel.id, latest);
      if (selectedChannelRef.current?.id !== channel.id) return;
      setMessages((current) => catchUpMessages(current, shown, outboxForChannel(channel.id)));
      if (!windowHiddenRef.current) sendAck(channel.id, lastRealMessageId(latest));
    } catch {
      // Cut off again: the next Ready tries again.
    }
  }

  function handleGatewayEvent(event: GatewayEvent) {
    switch (event.t) {
      case "Ready":
        gatewayRef.current?.send({ t: "SetPrivacyMode", d: { enabled: privacyModeRef.current } });
        setCurrentUser(event.d.user);
        setServers(event.d.servers);
        setDms(event.d.dms);
        // Who each 1:1 DM is with, so every chat in the list has a name after a reload.
        if (event.d.dm_peers) {
          const peers = event.d.dm_peers;
          for (const [channelId, peer] of Object.entries(peers)) dmPeerRef.current.set(channelId, peer.id);
          setDmUsers((prev) => ({ ...prev, ...peers }));
          const gone = dmsWithNoPeer(event.d.dms, peers);
          setGoneDms(new Set(gone));
          if (gone.length > 0) setDmUsers((prev) => ({ ...prev, ...Object.fromEntries(gone.map((id) => [id, GONE_PEER])) }));
        }
        // Earlier builds could mark a server channel as encrypted (C-H6). Drop stored
        // entries Ready lists as server channels; keep DMs and ids it doesn't mention.
        setE2eChannels((prev) => {
          const next = withoutServerChannels(prev, event.d.servers.flatMap((s) => s.channels));
          if (next === prev) return prev;
          saveEncryptedChannels(next);
          return new Set(next);
        });
        // Catch up on group rekeys that happened while we were offline: if a group's
        // server epoch is ahead of our own sender key, this rotates us and redistributes.
        for (const d of event.d.dms) {
          if (d.channel_type === "group_dm") syncGroupEpoch(d.id, d.epoch);
        }
        // Seed unread badges from the server so they no longer wipe to zero on reload.
        setUnread(event.d.unread ?? {});
        setNotifSettings(settingsFromList(event.d.notification_settings ?? []));
        {
          // The threads you follow; their unread counts are in `unread` above.
          const followed = event.d.followed_threads ?? [];
          for (const t of followed) {
            threadIdsRef.current.add(t.id);
            if (t.parent_id) threadParentRef.current.set(t.id, t.parent_id);
          }
          setFollowedThreads(new Set(followed.map((t) => t.id)));
        }
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
        // Every Ready after the first means this device was cut off for a while: catch the
        // open chat up, and look for a device added to the account meanwhile (its
        // DeviceAdded went to sockets that were open then).
        if (sawReadyRef.current) {
          void catchUpOpenChat();
          void checkOwnDevices(token, event.d.user.id);
        }
        sawReadyRef.current = true;
        pluginManagerRef.current.emit("ready", event.d);
        break;

      case "MessageCreate": {
        const msg = event.d;
        typing.clearTyping(msg.channel_id, msg.author.id);
        newestMessageAtRef.current.set(msg.channel_id, Math.max(newestMessageAtRef.current.get(msg.channel_id) ?? 0, msg.created_at));
        if (threadIdsRef.current.has(msg.channel_id)) {
          // A reply in a thread: an open thread shows it (and marks it read) itself. A thread
          // you follow counts as unread and notifies like its channel; any other thread only
          // notifies when the reply mentions you.
          const me = currentUserRef.current;
          if (!me || msg.author.id === me.id) break;
          const following = followedThreadsRef.current.has(msg.channel_id);
          const mentioned = mentionsMe(msg.content, msg.author, me.username);
          const isOpen = openThreadRef.current?.id === msg.channel_id && !windowHiddenRef.current;
          if (following && !isOpen) {
            setUnread((prev) => ({ ...prev, [msg.channel_id]: (prev[msg.channel_id] ?? 0) + 1 }));
          }
          if ((following || mentioned) && !isOpen) maybeNotify(msg);
          break;
        }
        if (msg.call) {
          // A call log: it shows in the chat, but the ring is the notification. It only counts
          // as unread once it's a call you missed (MessageUpdate).
          if (selectedChannelRef.current?.id === msg.channel_id) {
            setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
          }
          break;
        }
        if (selectedChannelRef.current?.id === msg.channel_id) {
          // Dedup by id: a duplicate MessageCreate (gateway replay, or a resend whose
          // first response was lost) must not render the message twice.
          setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
          if (isEncrypted(msg.content) || isSignalCiphertext(msg.content) || isGroupCiphertext(msg.content)) {
            void decryptMessages(msg.channel_id, [msg]).then((dec) => {
              const dm = dec[0];
              if (dm) setMessages((prev) => prev.map((m) => (m.id === dm.id ? afterDecryptAttempt(m, dm) : m)));
            });
          }
          const isFromMe = !currentUserRef.current || msg.author.id === currentUserRef.current.id;
          const arrival = arrivalInOpenChat(windowHiddenRef.current, isFromMe);
          // You're looking at this channel → it's read. Advance the cursor.
          if (arrival === "read") sendAck(msg.channel_id, msg.id);
          // The window is hidden in the tray: it arrived, but nobody has seen it yet.
          if (arrival === "unread") setUnread((prev) => ({ ...prev, [msg.channel_id]: (prev[msg.channel_id] ?? 0) + 1 }));
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
          mentionsMe(msg.content, msg.author, currentUserRef.current.username)
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
        if (msg.call) {
          // Someone answered the call you're making: it's no longer just ringing.
          if (msg.call.state !== "ringing" && outgoingCallRef.current === msg.channel_id) setOutgoingCall(null);
          // A call you missed counts as unread unless you're looking at that chat.
          const me = currentUserRef.current;
          const lookingAtIt = selectedChannelRef.current?.id === msg.channel_id && !windowHiddenRef.current;
          if (me && !lookingAtIt && callCountsAsUnread(msg.call, me.id, msg.author.id)) {
            setUnread((prev) => ({ ...prev, [msg.channel_id]: (prev[msg.channel_id] ?? 0) + 1 }));
          }
          break;
        }
        // Edited E2E messages arrive as ciphertext — decrypt for the viewer (mirrors MessageCreate).
        if (isEncrypted(msg.content) || isSignalCiphertext(msg.content) || isGroupCiphertext(msg.content)) {
          void decryptMessages(msg.channel_id, [msg]).then((dec) => {
            const dm = dec[0];
            if (dm) setMessages((prev) => prev.map((m) => (m.id === dm.id ? afterDecryptAttempt(m, dm) : m)));
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

      case "SlowmodeUpdate": {
        const { channel_id, seconds } = event.d;
        const patch = (c: Channel): Channel => (c.id === channel_id ? { ...c, slowmode_seconds: seconds } : c);
        setServers((prev) => prev.map((s) => ({ ...s, channels: s.channels.map(patch) })));
        setSelectedChannel((prev) => (prev ? patch(prev) : prev));
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
          if (event.d.channel_type === "dm" && !dmUsersRef.current[event.d.id]) void nameDm(event.d.id);
        }
        break;

      case "ThreadDelete": {
        // A thread was deleted with its replies: the line under its message goes.
        const { id, parent_id: parent } = event.d;
        setThreadsByParent((prev) => (prev[parent] ? { ...prev, [parent]: removeThread(prev[parent], id) } : prev));
        setOpenThread((prev) => (prev?.id === id ? null : prev));
        setFollowedThreads((prev) => withFollow(prev, id, false));
        setUnread((prev) => withoutUnread(prev, id));
        threadIdsRef.current.delete(id);
        break;
      }

      case "ThreadFollowUpdate": {
        // You followed or unfollowed a thread, here or on another of your devices.
        const { thread, following } = event.d;
        threadIdsRef.current.add(thread.id);
        if (thread.parent_id) threadParentRef.current.set(thread.id, thread.parent_id);
        setFollowedThreads((prev) => withFollow(prev, thread.id, following));
        if (!following) setUnread((prev) => withoutUnread(prev, thread.id));
        break;
      }

      case "ThreadUpdate": {
        // A thread started, got a reply, lost one, or lost its first message.
        const thread = event.d;
        threadIdsRef.current.add(thread.id);
        if (thread.parent_id) threadParentRef.current.set(thread.id, thread.parent_id);
        const parent = thread.parent_id;
        if (parent) setThreadsByParent((prev) => ({ ...prev, [parent]: upsertThread(prev[parent] ?? [], thread) }));
        setOpenThread((prev) => (prev?.id === thread.id ? thread : prev));
        break;
      }

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

      case "UserDeleted": {
        // An account was deleted: its messages leave the screen, and a 1:1 chat with it is
        // named "Deleted account" with no way to reply.
        const { user_id } = event.d;
        const chats = dmsWith(dmUsersRef.current, user_id);
        if (chats.length > 0) {
          setGoneDms((prev) => new Set([...prev, ...chats]));
          setDmUsers((prev) => ({ ...prev, ...Object.fromEntries(chats.map((id) => [id, GONE_PEER])) }));
        }
        setMessages((prev) => withoutAuthor(prev, user_id));
        setOnlineUsers((prev) => {
          if (!prev.has(user_id)) return prev;
          const next = new Set(prev);
          next.delete(user_id);
          return next;
        });
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

      case "ReadStateUpdate": {
        // A chat clears only when the mark covers the newest message this device has heard
        // of: one that came in after it (sent just as you read) stays unread.
        const read = new Set(
          event.d.reads
            .filter((r) => r.last_read_at >= (newestMessageAtRef.current.get(r.channel_id) ?? 0))
            .map((r) => r.channel_id)
        );
        setUnread((prev) => {
          if (![...read].some((id) => prev[id])) return prev;
          const next = { ...prev };
          for (const id of read) delete next[id];
          return next;
        });
        setMentions((prev) => {
          if (![...read].some((id) => prev.has(id))) return prev;
          const next = new Set(prev);
          for (const id of read) next.delete(id);
          return next;
        });
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

      case "NotificationSettingsUpdate":
        // Changed on this device or another: every device follows.
        setNotifSettings((prev) => withSetting(prev, event.d));
        break;

      case "TwoFactorUpdate":
        // An open Settings card reloads; a change made elsewhere is worth a word, since
        // nobody should be surprised by a new step when signing in.
        window.dispatchEvent(new Event(TWO_FACTOR_EVENT));
        if (shouldAnnounceTwoFactorChange(twoFactorChangedHereAt(), Date.now())) {
          toast(
            event.d.enabled
              ? "Two-factor sign-in was turned on from another device."
              : "Two-factor sign-in was turned off from another device.",
            "info",
          );
        }
        break;

      case "DeviceAdded": {
        // Another device registered on this account. Our own first registration comes
        // back here too; that one is not news.
        const me = currentUserRef.current?.id;
        if (me && event.d.device_id !== deviceId()) void checkOwnDevices(token, me);
        break;
      }

      case "WatchUpdate": {
        if (event.d.channel_id === selectedChannelRef.current?.id) {
          const s = event.d.session;
          setWatchSession(s ? onLocalClock(s, Date.now() / 1000) : null);
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
        // Our roles changed, or we were timed out or let off — refresh live, no reload needed.
        if (event.d.server_id === selectedServerIdRef.current) {
          api.getMyPermissions(token, event.d.server_id)
            .then((p) => {
              setMyPerms(p.permissions);
              setMyTimeoutUntil(p.timed_out_until ?? null);
            })
            .catch(() => {});
        }
        break;

      case "EventsChanged":
        // Someone added/RSVP'd/removed an event — nudge an open Events panel to refetch.
        if (event.d.server_id === selectedServerIdRef.current) {
          setEventsRefresh((n) => n + 1);
        }
        break;

      case "CallRing": {
        const d = event.d;
        if (blockedUserIdsRef.current.has(d.caller.id) || webrtcRef.current?.channelId === d.channel_id) break;
        const nowSecs = Math.floor(Date.now() / 1000);
        const ring: IncomingRing = {
          channelId: d.channel_id,
          messageId: d.message_id,
          callerId: d.caller.id,
          callerName: d.caller.display_name || d.caller.username,
          video: d.video,
          // The server stops the ring on time; this is only the fallback for a stop that never
          // arrives, so a clock that runs fast can't cut a ring short.
          ringUntil: Math.max(d.ring_until, nowSecs + RING_FALLBACK_MIN_SECS) + RING_FALLBACK_GRACE_SECS,
        };
        setRings((prev) => nextRings(prev, { type: "ring", ring }));
        notifyRing(ring);
        break;
      }

      case "CallRingStop":
        setRings((prev) => nextRings(prev, { type: "stop", channelId: event.d.channel_id }));
        break;

      case "CallEnded": {
        const { channel_id, outcome } = event.d;
        setRings((prev) => nextRings(prev, { type: "stop", channelId: channel_id }));
        const wasCalling = outgoingCallRef.current === channel_id;
        if (wasCalling) setOutgoingCall(null);
        // A one-to-one call ends for both when one hangs up: leave it here too.
        if (webrtcRef.current?.channelId === channel_id) {
          webrtcRef.current.hangUp();
          if (wasCalling && outcome === "declined") toast("They declined the call.");
          else if (wasCalling && outcome === "missed") toast("No answer.");
        }
        break;
      }

      case "VoiceRefused":
        if (webrtcRef.current?.channelId === event.d.channel_id) webrtcRef.current.hangUp();
        if (outgoingCallRef.current === event.d.channel_id) setOutgoingCall(null);
        toast(`This call is full (up to ${DM_CALL_SEATS} people).`, "error");
        break;

      case "VoiceRoster":
        webrtcRef.current?.onRoster(event.d.channel_id, event.d.peers);
        setVoiceParticipantsByChannel((prev) => {
          const next = new Map(prev);
          const existing = new Map(next.get(event.d.channel_id) ?? []);
          for (const peer of event.d.peers) {
            existing.set(peer.user_id, {
              user_id: peer.user_id,
              user: peer.user,
              muted: peer.muted,
              video: peer.video,
              screen: peer.screen,
              listenOnly: Boolean(peer.listenOnly),
            });
          }
          next.set(event.d.channel_id, existing);
          return next;
        });
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
        setVoiceParticipantsByChannel((prev) => {
          const next = new Map<string, Map<string, VoiceSidebarParticipant>>();
          for (const [cid, members] of prev) {
            const copy = new Map(members);
            // A user can only be in one Ohiyo voice room at a time. Remove stale
            // previews from any prior room before adding the fresh state below.
            if (joined || cid === channel_id) copy.delete(user_id);
            if (copy.size) next.set(cid, copy);
          }
          if (joined) {
            const members = new Map(next.get(channel_id) ?? []);
            members.set(user_id, {
              user_id,
              user: event.d.user,
              muted: event.d.muted,
              video: event.d.video,
              screen: event.d.screen,
              listenOnly: Boolean(event.d.listenOnly),
              deafened: Boolean(event.d.deafened),
            });
            next.set(channel_id, members);
          }
          return next;
        });
        break;
      }
    }
  }

  // Core shortcuts work without the optional Keyboard Navigator plugin.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setShowCommandPalette(true);
      }
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
  // Follow or stop following a thread: at once on screen, undone if the server says no.
  async function toggleThreadFollow(thread: ThreadSummary) {
    const following = !followedThreadsRef.current.has(thread.id);
    setFollowedThreads((prev) => withFollow(prev, thread.id, following));
    if (!following) setUnread((prev) => withoutUnread(prev, thread.id));
    try {
      await api.setThreadFollow(token, thread.id, following);
    } catch {
      setFollowedThreads((prev) => withFollow(prev, thread.id, !following));
      toast(following ? "Couldn't follow the thread." : "Couldn't unfollow the thread.", "error");
    }
  }

  function sendAck(channelId: string, messageId: string | undefined) {
    if (!messageId || messageId.startsWith("temp-")) return;
    if (lastAckRef.current[channelId] === messageId) return;
    const ok = gatewayRef.current?.send({ t: "Ack", d: { channel_id: channelId, message_id: messageId } });
    if (ok) lastAckRef.current[channelId] = messageId;
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
    const waiting = unreadRef.current[channel.id] ?? 0;
    setUnreadMarker(waiting > 0 ? { channelId: channel.id, count: waiting } : null);
    // Reset + fetch the watch-party state for the channel we're entering.
    setWatchSession(null);
    api.getWatch(token, channel.id)
      .then((s) => {
        if (selectedChannelRef.current?.id === channel.id) setWatchSession(s ? onLocalClock(s, Date.now() / 1000) : null);
      })
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

  // Resolve a DM peer's user id (from the channel's participant list, or dmUsers).
  const dmPeerId = useCallback(
    (channelId: string): string | undefined =>
      dmPeerRef.current.get(channelId) ?? dmUsersRef.current[channelId]?.id,
    []
  );
  // The DM's peer as known, else learned from its participant list (never from message
  // authors) and remembered. After a reload nothing is known for a DM whose loaded page
  // has no ciphertext.
  const learnDmPeer = useCallback(
    async (channelId: string): Promise<string | undefined> => {
      const peer = await resolveDmPeer(dmPeerId(channelId), () => api.listRecipients(token, channelId), currentUserRef.current?.id);
      if (peer) dmPeerRef.current.set(channelId, peer);
      return peer;
    },
    [dmPeerId, token]
  );

  // Devices added to this account since this device last looked (deviceWatch).
  const ownNewDevices = useSyncExternalStore<NewDevice[]>(onNewDevicesChange, () =>
    currentUser ? newDevices(currentUser.id) : NO_NEW_DEVICES
  );
  const [removingNewDevices, setRemovingNewDevices] = useState(false);

  // End every session of this account (this one too), then show the sign-in screen
  // without removing anything stored on this device.
  async function signOutEverywhere(): Promise<void> {
    await api.logoutEverywhere(token);
    onBackToSignIn();
  }

  // "Not me": take the new devices off the account, then end every session, so a stolen
  // session that added them is cut off too.
  async function removeNewDevices(): Promise<void> {
    const me = currentUser?.id;
    if (!me) return;
    const ids = ownNewDevices.map((d) => d.device_id);
    setRemovingNewDevices(true);
    try {
      await notMe(ids, {
        removeDevice: (id) => api.removeDevice(token, id),
        endAllSessions: () => api.logoutEverywhere(token),
        forget: (gone) => forgetDevices(me, gone),
      });
      onBackToSignIn();
    } catch {
      toast("Couldn't remove it. Check your connection and try again.", "error");
      setRemovingNewDevices(false);
    }
  }

  // Verification state for the open DM's peer — drives the "safety number changed"
  // warning + the Verified badge. identityTrust is an external store; subscribing
  // re-renders on any key-change / verify / dismiss without manual ticks.
  const e2eTrust = useSyncExternalStore<TrustState>(onIdentityChange, () => {
    const peer = selectedChannel?.channel_type === "dm" ? dmPeerId(selectedChannel.id) : undefined;
    return peer ? trustState(peer) : "unverified";
  });

  // Opening an encrypted DM checks the contact's devices, so a new one is announced even
  // before you send anything (sending checks again).
  const openDmPeer =
    selectedChannel?.channel_type === "dm" && e2eChannels.has(selectedChannel.id) ? dmPeerId(selectedChannel.id) : undefined;
  useEffect(() => {
    if (openDmPeer) void refreshContactDevices(token, openDmPeer);
  }, [openDmPeer, token]);

  // E2E: derive (and cache) the shared AES key for a DM from my private key + the
  // peer's published public key (LEGACY static-key scheme; new sessions use Signal).
  const getDmKey = useCallback(
    async (channelId: string): Promise<CryptoKey | null> => {
      const cached = dmKeyCacheRef.current.get(channelId);
      if (cached) return cached;
      // Peer = from the participant list OR dmUsers (whichever we know).
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
  // encrypted pairwise so the server stays blind. Once per group/session; concurrent
  // callers await the same in-flight run, and a failure rejects them (then retries next time).
  const senderKeyDistributionRef = useRef(createDistributionTracker());
  const distributeMySenderKey = useCallback(
    (channelId: string): Promise<void> =>
      senderKeyDistributionRef.current.ensure(channelId, async () => {
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
      }),
    [token]
  );

  // The type of a channel we know about (open, DM list, or a joined server).
  const channelTypeOf = useCallback((channelId: string): Channel["channel_type"] | undefined => {
    if (selectedChannelRef.current?.id === channelId) return selectedChannelRef.current.channel_type;
    const dm = dmsRef.current.find((d) => d.id === channelId);
    if (dm) return dm.channel_type;
    for (const s of serversRef.current) {
      const c = s.channels.find((ch) => ch.id === channelId);
      if (c) return c.channel_type;
    }
    return undefined;
  }, []);

  // Encrypt for a channel in encrypted mode: ciphertext or a thrown EncryptedSendError,
  // never the plaintext. Groups use our sender key (distributed first), DMs Signal.
  const encryptForChannel = useCallback(
    (channelId: string, channelType: Channel["channel_type"] | undefined, padded: string): Promise<string> =>
      encryptOutgoing(channelType, padded, {
        ensureSenderKey: () => distributeMySenderKey(channelId),
        groupEncrypt: async (pt) => {
          const wire = await groupEncrypt(channelId, pt);
          // No sender key on this device any more: mint and distribute one on the next try.
          if (!wire) senderKeyDistributionRef.current.forget(channelId);
          return wire;
        },
        pairwiseEncrypt: async (pt) => {
          const peerId = await learnDmPeer(channelId);
          return peerId ? encryptFor(token, peerId, pt) : null;
        },
      }),
    [token, learnDmPeer, distributeMySenderKey]
  );

  const decryptMessages = useCallback(
    async (channelId: string, msgs: Message[]): Promise<Message[]> => {
      if (
        !msgs.some((m) => isEncrypted(m.content) || isSignalCiphertext(m.content) || isGroupCiphertext(m.content))
      )
        return msgs;
      const channelType = channelTypeOf(channelId);
      const contents = msgs.map((m) => m.content);
      // The conversation is encrypted → reflect it locally (sticky + mutual): the
      // recipient's UI flips to encrypted mode and their replies encrypt too. Only in a
      // DM / group DM, and only for a well-formed envelope (or, below, a message that
      // decrypted) — never for text that merely starts with an envelope prefix.
      const enterEncryptedMode = () =>
        setE2eChannels((prev) => {
          if (prev.has(channelId)) return prev;
          const next = new Set(prev);
          next.add(channelId);
          saveEncryptedChannels(next);
          dropDraftsEnteringEncryptedMode(prev, next);
          return next;
        });
      const wellFormed = shouldEnterEncryptedMode(channelType, contents, false);
      if (wellFormed) enterEncryptedMode();
      // The 1:1 peer comes from the channel's participant list, never message authors.
      // Offline, Signal messages stay undecryptable until the next load.
      const peerId = channelType === "dm" ? await learnDmPeer(channelId) : undefined;
      const decryptStateFor = (messageId: string): "unknown" | "not_covered" | "restore_failed" => {
        const coverage = coverageForMessage(messageId);
        if (
          coverage === "not_covered" ||
          coverage === "signal_missing_session" ||
          coverage === "signal_not_addressed" ||
          coverage === "signal_corrupt"
        ) return "not_covered";
        if (sessionStorage.getItem("ohiyo:recovery-restored-at")) return "restore_failed";
        return "unknown";
      };
      // Inventory encrypted-message headers durably before attempting decrypt, so the
      // restore preview can reason about messages loaded in a previous browser session.
      for (const m of msgs) {
        if (!shouldRecordRecoveryInventory(channelType, m.content)) continue;
        if (isGroupCiphertext(m.content)) {
          const header = parseGroupCiphertextHeader(m.content);
          if (header) recordGroupSenderKeyMessage({ message_id: m.id, room_id: channelId, epoch: header.epoch, key_id: String(header.keyId) });
        } else if (isSignalCiphertext(m.content)) {
          const header = parseSignalCiphertextHeader(m.content);
          if (header) recordSignalMessage({
            message_id: m.id,
            channel_id: channelId,
            author_id: m.author.id,
            sender_device_id: header.sender_device_id,
            recipient_count: header.recipient_count,
          });
        }
      }
      // Sequential: the Double Ratchet requires in-order processing of new messages. A
      // message whose decrypt throws shows as undecryptable; the rest still load.
      let decryptedAny = false;
      const undecryptable = (m: Message): Message => ({ ...m, content: "", _encrypted: true, _decryptState: decryptStateFor(m.id) });
      const out = await decryptEach(msgs, async (m) => {
        if ((isGroupCiphertext(m.content) || isSignalCiphertext(m.content)) && !isWellFormedEnvelope(m.content)) {
          // Only looks like ciphertext: show it as undecryptable and touch nothing else.
          return undecryptable(m);
        } else if (isGroupCiphertext(m.content)) {
          // Group sender-key message — decrypt from the message author's sender key.
          const cached = getCachedPlaintext(m.id);
          if (cached !== null) {
            decryptedAny = true;
            return messageFromDecryptedPlaintext(m, cached);
          }
          const pt = await groupDecrypt(channelId, m.author.id, m.content);
          const plain = pt !== null ? unpadMessagePlaintext(pt) : null;
          if (plain !== null) {
            cachePlaintext(m.id, plain, messageExpiry(m));
            decryptedAny = true;
          }
          return plain !== null ? messageFromDecryptedPlaintext(m, plain) : undecryptable(m);
        } else if (isSignalCiphertext(m.content)) {
          const cached = getCachedPlaintext(m.id);
          if (cached !== null) {
            decryptedAny = true;
            return messageFromDecryptedPlaintext(m, cached);
          }
          const pt = peerId ? await decryptFrom(peerId, m.content) : null;
          const plain = pt !== null ? unpadMessagePlaintext(pt) : null;
          if (plain !== null) {
            cachePlaintext(m.id, plain, messageExpiry(m));
            decryptedAny = true;
          }
          return plain !== null ? messageFromDecryptedPlaintext(m, plain) : undecryptable(m);
        } else if (isEncrypted(m.content)) {
          // The first, static-key format: a server could forge one, so it isn't opened.
          return undecryptable(m);
        }
        return m;
      }, undecryptable);
      if (!wellFormed && shouldEnterEncryptedMode(channelType, contents, decryptedAny)) enterEncryptedMode();
      return out;
    },
    [learnDmPeer, channelTypeOf]
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
            // A failure here resurfaces on the next send, which awaits a fresh attempt.
            distributeMySenderKey(channelId).catch(() => {});
          } else {
            void getDmKey(channelId).then((k) => {
              if (!k) toast("Your friend hasn't set up encryption yet — they just need to open Ohiyo once.");
            });
          }
        }
        saveEncryptedChannels(next);
        dropDraftsEnteringEncryptedMode(prev, next);
        return next;
      });
    },
    [getDmKey, toast, distributeMySenderKey]
  );

  const handleSend = useCallback(
    async (content: string, attachmentIds?: string[], replyTo?: string | null, encryptedAttachments?: EncryptedAttachmentMeta[]) => {
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
          attachments: encryptedAttachments?.length ? encryptedAttachments : null,
          reactions: [],
          _state: "pending",
          _send: { content, attachmentIds, replyTo, encryptedAttachments },
        };
        setMessages((prev) => [...prev, optimistic]);
        addToOutbox(optimistic); // persisted so it survives a switch/reload/offline
      }
      try {
        const cid = selectedChannelRef.current!.id;
        const channelType = selectedChannelRef.current!.channel_type;
        const privatePlaintext = packEncryptedMessagePlaintext(content, encryptedAttachments);
        // E2E: encrypt on this device before it leaves — the server only sees ciphertext.
        // Group: one sender-key ciphertext every member decrypts. 1:1: a forward-secret
        // Signal session (no legacy static-key fallback). Never plaintext, and never a file
        // uploaded in the clear: on failure the message stays in the failed state with Retry.
        const wire = await outgoingWire({ content, attachmentIds, encryptedAttachments }, e2eChannelsRef.current.has(cid), async () => {
          try {
            return await encryptForChannel(cid, channelType, padMessagePlaintext(privatePlaintext));
          } catch (err) {
            if (err instanceof EncryptedSendError && err.reason === "no-signal-session") {
              toast("Can't send encrypted yet — your friend needs to open Ohiyo once to set up encryption.");
            }
            throw err;
          }
        });
        const created = await api.sendMessage(token, cid, wire, attachmentIds, replyTo);
        completeActivation("message");
        // Forward secrecy: we can't decrypt our own outgoing ciphertext later (1:1
        // ratchet or group sender key), so cache the plaintext by the real message id.
        if ((isSignalCiphertext(wire) || isGroupCiphertext(wire)) && created?.id) {
          cachePlaintext(created.id, privatePlaintext, messageExpiry(created));
          // If the gateway echo already rendered this as a placeholder (it can't
          // self-decrypt), put the text back and drop its "can't decrypt" notice.
          setMessages((prev) => prev.map((m) => (m.id === created.id ? withOwnPlaintext(m, content, encryptedAttachments) : m)));
        }
        setMessages((prev) => prev.filter((m) => m.id !== tempId));
        removeFromOutbox(tempId);
      } catch (err) {
        // e.g. more attachments than the server allows, slowmode, or a time out
        const refused = badRequestMessage(err) ?? moderationRefusal(err);
        if (err instanceof EncryptedSendError && err.reason === "unencrypted-attachment") toast(err.message, "error");
        else if (refused) toast(`Couldn't send: ${refused}`, "error");
        // Keep the message visible in a failed state (persisted) so it can be retried.
        setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, _state: "failed" } : m)));
        setOutboxState(tempId, "failed");
      }
    },
    [token, toast, encryptForChannel, completeActivation]
  );

  // Retry a failed/queued message using its stored send args.
  const handleRetryMessage = useCallback(
    async (msg: Message) => {
      const send = msg._send;
      if (!send) return;
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, _state: "pending" } : m)));
      setOutboxState(msg.id, "pending");
      try {
        const privatePlaintext = packEncryptedMessagePlaintext(send.content, send.encryptedAttachments as EncryptedAttachmentMeta[] | undefined);
        // The channel's type picks group vs 1:1. Unknown (e.g. before Ready), no
        // ciphertext, or a file uploaded in the clear → throws, so the message stays failed.
        const wire = await outgoingWire(send, e2eChannelsRef.current.has(msg.channel_id), () =>
          encryptForChannel(msg.channel_id, channelTypeOf(msg.channel_id), padMessagePlaintext(privatePlaintext)),
        );
        const created = await api.sendMessage(token, msg.channel_id, wire, send.attachmentIds, send.replyTo ?? null);
        if ((isSignalCiphertext(wire) || isGroupCiphertext(wire)) && created?.id) {
          cachePlaintext(created.id, privatePlaintext, messageExpiry(created));
          setMessages((prev) => prev.map((m) => (m.id === created.id ? withOwnPlaintext(m, send.content, send.encryptedAttachments ?? undefined) : m)));
        }
        setMessages((prev) => prev.filter((m) => m.id !== msg.id));
        removeFromOutbox(msg.id);
      } catch (err) {
        // e.g. more attachments than the server allows, slowmode, or a time out
        const refused = badRequestMessage(err) ?? moderationRefusal(err);
        if (err instanceof EncryptedSendError && err.reason === "unencrypted-attachment") toast(err.message, "error");
        else if (refused) toast(`Couldn't send: ${refused}`, "error");
        setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, _state: "failed" } : m)));
        setOutboxState(msg.id, "failed");
      }
    },
    [token, toast, encryptForChannel, channelTypeOf]
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

  // The server refused this session (it expired, or every session was ended from another
  // device or by a password change). Go to sign-in, keeping what's stored on this device.
  // A gateway still holding a token this device has just replaced (its own password
  // change) can land here first, so check the current token before signing out.
  const latestTokenRef = useRef(token);
  latestTokenRef.current = token;
  useEffect(() => {
    if (connStatus !== "signed_out") return;
    let alive = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const check = (attempt: number) => {
      const checked = latestTokenRef.current;
      api.me(checked).then(
        () => {
          // Still signed in. If the token didn't change either, try the socket again.
          if (alive && latestTokenRef.current === checked) void gatewayRef.current?.connect();
        },
        (err: unknown) => {
          if (!alive) return;
          if (apiStatus(err) !== 401) {
            // The question itself failed (offline, server busy): ask again in a while,
            // rather than leave this device on "Signed out" with no way forward.
            retry = setTimeout(() => check(attempt + 1), Math.min(SIGNED_OUT_RECHECK_MAX_MS, 2_000 * 2 ** attempt));
            return;
          }
          // Another tab of this browser may hold a newer session for this home (its own
          // password change ends this one and stores a new one for both): carry on with it,
          // rather than clear it and sign that tab out too.
          const stored = loadHomes().find((h) => h.id === activeHomeId)?.token ?? null;
          if (stored && stored !== checked) {
            onTokenChange(stored);
            return;
          }
          setSignInNotice("You were signed out on this device. Sign in again to carry on.");
          onBackToSignIn();
        }
      );
    };
    check(0);
    return () => {
      alive = false;
      clearTimeout(retry);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- react to the status only; onBackToSignIn is a fresh closure each render
  }, [connStatus]);

  // ── Message actions (edit / delete / pin) — UI updates arrive via gateway echo.
  async function handleEditMessage(messageId: string, content: string) {
    const ch = selectedChannelRef.current;
    const cid = ch?.id;
    if (!cid) return;
    const blocked = editBlockReason(messages.find((m) => m.id === messageId), e2eChannelsRef.current.has(cid));
    if (blocked) {
      toast(blocked, "error");
      return;
    }
    try {
      let wire = content;
      // E2E: encrypt the edit on-device too — editing must NOT leak plaintext to the
      // server (mirrors handleSend; without this an edited E2E message went out in clear).
      if (content && e2eChannelsRef.current.has(cid)) {
        try {
          wire = await encryptForChannel(cid, ch?.channel_type, padMessagePlaintext(content));
        } catch (err) {
          if (err instanceof EncryptedSendError && err.reason === "no-signal-session") {
            toast("Can't edit encrypted yet — your friend needs to open Ohiyo once to set up encryption.");
            return;
          }
          throw err; // e.g. no group ciphertext: "Couldn't edit: …", nothing sent
        }
      }
      const edited = await api.editMessage(token, cid, messageId, wire);
      // Forward secrecy: cache the new plaintext under the message id so our own view
      // (and later history reloads) shows it — we can't re-decrypt our own ciphertext.
      if (isSignalCiphertext(wire) || isGroupCiphertext(wire)) {
        cachePlaintext(messageId, content, messageExpiry(edited));
        setMessages((prev) => prev.map((m) => (m.id === messageId ? withOwnPlaintext(m, content) : m)));
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
    const blocked = forwardBlockReason(m, e2eChannelsRef.current.has(channelId));
    if (blocked) {
      toast(blocked, "error");
      return;
    }
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
    if (blockedUserIdsRef.current.has(msg.author.id)) return;
    // Notification settings: a muted chat stays quiet, a space may want only @mentions. A
    // thread follows the channel it hangs off: muted with it, and an @mention still gets
    // through unless the space is set to Nothing.
    const channelId = threadParentRef.current.get(msg.channel_id) ?? msg.channel_id;
    const serverId = serversRef.current.find((s) => s.channels.some((c) => c.id === channelId))?.id ?? null;
    const me = currentUserRef.current;
    // A webhook naming you doesn't count as a mention (lib/messageNotify.ts).
    const mentioned = serverId !== null && me !== null && mentionsMe(msg.content ?? "", msg.author, me.username);
    const nowSecs = Math.floor(Date.now() / 1000);
    // A thread you follow notifies like its channel; any other thread only for an @mention.
    const alert = threadParentRef.current.has(msg.channel_id)
      ? threadAlert(
          notifSettingsRef.current,
          { parentId: channelId, serverId },
          followedThreadsRef.current.has(msg.channel_id),
          mentioned,
          nowSecs,
        )
      : messageAlert(notifSettingsRef.current, { channelId, serverId }, mentioned, nowSecs);
    if (!alert.notify) return;
    const lookingAtIt = isLookingAt({
      openChannelId: selectedChannelRef.current?.id,
      messageChannelId: msg.channel_id,
      pageHidden: document.hidden,
      windowHidden: windowHiddenRef.current,
    });
    if (lookingAtIt) return;
    const body = msg.content?.slice(0, 140) || "Sent an attachment";
    // A sound follows the same rules (everything above), and by default only for a DM or an
    // @mention (lib/notificationSounds.ts).
    const sounds = loadSoundPrefs();
    const playIt = shouldPlaySound(
      { fromMe: false, blocked: false, notifyAllowed: true, lookingAtIt: false, isDirect: serverId === null && !threadParentRef.current.has(msg.channel_id), mentioned },
      sounds,
    );
    // Native OS notification under Tauri, Web Notification in a browser — but only from
    // ONE tab/window when several are open (claimNotification), so no double-ping.
    void claimNotification(msg.id).then((mine) => {
      if (!mine) return;
      if (playIt) playSound(sounds.sound, sounds.volume);
      void notify({ title: notificationTitle(msg.author), body });
    });
  }

  // A call that rings while you're away from Ohiyo also shows as a system notification,
  // unless its chat is muted. Like messages, only one tab or window shows it.
  function notifyRing(ring: IncomingRing) {
    const away = document.hidden || windowHiddenRef.current;
    const nowSecs = Math.floor(Date.now() / 1000);
    if (!away || isMuted(notifSettingsRef.current[settingKey("channel", ring.channelId)], nowSecs)) return;
    void claimNotification(`call:${ring.messageId}`).then((mine) => {
      if (mine) void notify({ title: ring.callerName, body: ring.video ? "Incoming video call" : "Incoming call" });
    });
  }

  // Go to a search result. Open its channel, then page back through its history until the
  // message is there (a channel opens on its latest page), and have the chat scroll to it and
  // mark it. A result in a thread opens that thread beside its channel.
  async function jumpToMessage(hit: SearchHit) {
    const channelId = hit.thread_parent_id ?? hit.channel_id;
    let channel: Channel | undefined;
    for (const s of serversRef.current) {
      channel = s.channels.find((c) => c.id === channelId);
      if (channel) {
        setSelectedServerId(s.id);
        break;
      }
    }
    if (!channel) return;
    if (selectedChannelRef.current?.id !== channel.id) await handleSelectChannel(channel);
    if (selectedChannelRef.current?.id !== channel.id) return;
    if (hit.thread_parent_id) {
      const threads = await api.listThreads(token, hit.thread_parent_id).catch(() => []);
      const thread = threads.find((t) => t.id === hit.channel_id);
      if (thread && selectedChannelRef.current?.id === channel.id) setOpenThread(thread);
      return;
    }
    try {
      let history = await api.listMessages(token, channel.id, JUMP_PAGE);
      for (let page = 1; page < JUMP_PAGES && !history.some((m) => m.id === hit.id) && history.length > 0; page += 1) {
        const older = await api.listMessages(token, channel.id, JUMP_PAGE, history[0].id);
        if (!older.length) break;
        history = [...older, ...history];
      }
      if (selectedChannelRef.current?.id !== channel.id) return;
      const found = history.some((m) => m.id === hit.id);
      // Keep what arrived meanwhile (newer messages, unsent drafts) after the loaded history.
      setMessages((prev) => {
        const loaded = new Set(history.map((m) => m.id));
        return [...history, ...prev.filter((m) => !loaded.has(m.id))];
      });
      if (found) setFocusMessage({ id: hit.id, seq: Date.now(), channelId: channel.id });
      else toast("That message is too far back to jump to.", "info");
    } catch {
      toast("Couldn't open that message. Check your connection and try again.", "error");
    }
  }

  // The catch-up bar's Jump when the first unread message isn't loaded yet: page back through
  // the open chat's history (decrypting, in an encrypted chat) until it is. The chat then
  // scrolls the "New messages" line into view.
  async function jumpToFirstUnread() {
    const channel = selectedChannelRef.current;
    const marker = unreadMarker;
    const me = currentUser?.id;
    if (!channel || !marker || marker.channelId !== channel.id || !me) return;
    let history = messages.filter((m) => m.channel_id === channel.id && !m.id.startsWith("temp-"));
    try {
      for (let page = 0; page < JUMP_PAGES && firstUnreadId(history, marker.count, me) === "older"; page += 1) {
        const oldest = history[0]?.id;
        if (!oldest) break;
        const older = await api.listMessages(token, channel.id, JUMP_PAGE, oldest);
        if (!older.length) break;
        const shown = await decryptMessages(channel.id, older);
        if (selectedChannelRef.current?.id !== channel.id) return;
        history = [...shown, ...history];
      }
      if (selectedChannelRef.current?.id !== channel.id) return;
      setMessages((prev) => {
        const loaded = new Set(history.map((m) => m.id));
        return [...history, ...prev.filter((m) => !loaded.has(m.id))];
      });
      if (firstUnreadId(history, marker.count, me) === "older") toast("The first new message is too far back to jump to.", "info");
    } catch {
      toast("Couldn't load older messages. Check your connection and try again.", "error");
    }
  }

  // Mark chats read (a chat's own menu, the space menu, Shift+Esc). Their numbers clear at
  // once; the server marks them read up to their newest message and tells your other devices.
  // If it can't, the numbers come back.
  async function markChatsRead(channelIds: string[]) {
    const ids = [...new Set(channelIds)];
    if (!ids.length) return;
    const before: Record<string, number> = {};
    for (const id of ids) if (unreadRef.current[id]) before[id] = unreadRef.current[id];
    const mentioned = ids.filter((id) => mentionsRef.current.has(id));
    setUnread((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });
    if (mentioned.length) {
      setMentions((prev) => {
        const next = new Set(prev);
        for (const id of mentioned) next.delete(id);
        return next;
      });
    }
    try {
      for (let i = 0; i < ids.length; i += MARK_READ_BATCH) await api.markRead(token, ids.slice(i, i + MARK_READ_BATCH));
    } catch {
      setUnread((prev) => {
        const next = { ...prev };
        for (const [id, n] of Object.entries(before)) next[id] = Math.max(next[id] ?? 0, n);
        return next;
      });
      if (mentioned.length) setMentions((prev) => new Set([...prev, ...mentioned]));
      toast("Couldn't mark that as read. Check your connection and try again.", "error");
    }
  }

  // Every channel in the open space, and the threads you follow in them.
  function markSpaceRead() {
    const space = serversRef.current.find((s) => s.id === selectedServerId);
    if (!space) return;
    const channelIds = new Set(space.channels.filter((c) => c.channel_type !== "voice").map((c) => c.id));
    const threads = [...followedThreadsRef.current].filter((id) => {
      const parent = threadParentRef.current.get(id);
      return parent !== undefined && channelIds.has(parent);
    });
    void markChatsRead([...channelIds, ...threads]);
  }

  // Shift+Esc: everything with a number or a mention.
  function markEverythingRead() {
    const ids = [
      ...Object.entries(unreadRef.current).filter(([, n]) => n > 0).map(([id]) => id),
      ...mentionsRef.current,
    ];
    void markChatsRead(ids);
    setUnreadMarker(null);
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

  // Ban a member (removed and blocked from rejoining), from the ban dialog. Throws, so the
  // dialog stays open saying why.
  async function handleBan(userId: string, choice: { reason: string; deleteMessageSeconds: number }) {
    if (!selectedServerId) return;
    await api.banMember(token, selectedServerId, userId, choice);
    toast("Member banned", "success");
  }

  // Time a member out, from the time out dialog (throws, so it stays open saying why).
  async function handleTimeout(userId: string, seconds: number, reason: string) {
    if (!selectedServerId) return;
    const timeout = await api.timeoutMember(token, selectedServerId, userId, seconds, reason);
    setMemberTimeouts((prev) => new Map(prev).set(userId, timeout.until));
  }

  async function handleRemoveTimeout(userId: string) {
    if (!selectedServerId) return;
    try {
      await api.removeTimeout(token, selectedServerId, userId);
      setMemberTimeouts((prev) => {
        const next = new Map(prev);
        next.delete(userId);
        return next;
      });
    } catch (err) {
      toast(`Couldn't end the time out: ${err instanceof Error ? err.message : err}`, "error");
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
  // A space left or deleted from here: off the list, and off the screen if it was shown.
  function dropServer(id: string) {
    setServers((prev) => prev.filter((s) => s.id !== id));
    if (selectedServerId === id) {
      setSelectedServerId(null);
      setSelectedChannel(null);
      setMessages([]);
    }
  }

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
    completeActivation("server");
    setActivationDismissedState(false);
    setActivationDismissed(currentUserRef.current?.id ?? currentUser?.id, false);
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

  function clearPrivateDmParam() {
    const url = new URL(window.location.href);
    url.searchParams.delete("dm");
    window.history.replaceState({}, "", url.pathname + url.search + url.hash);
    setPrivateDmToken(null);
  }

  /** Open a pasted invite code or link, or a one-time private DM link. False if it's neither. */
  function handleOpenSharedLink(raw: string): boolean {
    const link = parseSharedLink(raw, window.location.origin);
    if (!link) return false;
    if (link.kind === "invite") setInviteCode(link.code);
    else setPrivateDmToken(link.token);
    return true;
  }

  function handleInviteJoin(server: ServerWithChannels) {
    enterServer(server);
    clearInviteParam();
    toast(`You're in — welcome to ${server.name}! 🎉`, "success");
  }

  function handlePrivateDmAccepted(channel: Channel, creator: PublicUser) {
    setDms((prev) => (prev.find((d) => d.id === channel.id) ? prev : [channel, ...prev]));
    setDmUsers((prev) => ({ ...prev, [channel.id]: creator }));
    setSelectedServerId(null);
    markWelcomed();
    clearPrivateDmParam();
    void handleSelectChannel(channel);
    toast(`Private DM opened with ${creator.display_name}`, "success");
  }

  // ── Direct messages ─────────────────────────────────────────────────────────
  async function openDmWith(user: PublicUser) {
    if (blockedUserIds.has(user.id)) {
      toast("Unblock this user before messaging them.", "error");
      throw new Error("blocked");
    }
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

  async function reportTarget(target_type: "message" | "user" | "server", target_id: string, label: string) {
    const reason = window.prompt(`Why are you reporting this ${label}? For example: harassment, spam or unsafe content.`, "");
    if (!reason?.trim()) return;
    const details = window.prompt("Optional details for moderators", "") ?? "";
    try {
      await api.createReport(token, {
        target_type,
        target_id,
        reason: reason.trim(),
        details,
        server_id: target_type === "user" && selectedServerIdRef.current ? selectedServerIdRef.current : null,
      });
      toast("Report sent to moderators", "success");
      if (target_type === "message" && selectedChannelRef.current) {
        await api.hideMessage(token, selectedChannelRef.current.id, target_id, true).catch(() => {});
        setMessages((prev) => prev.filter((m) => m.id !== target_id));
      }
    } catch (err) {
      toast(`Couldn't report: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  async function blockUser(user: PublicUser) {
    if (!window.confirm(`Block ${user.display_name || user.username}? Their messages and notifications will be hidden for you.`)) return;
    try {
      await api.blockUser(token, user.id);
      setBlockedUserIds((prev) => new Set([...prev, user.id]));
      setMessages((prev) => prev.filter((m) => m.author.id !== user.id));
      toast("User blocked", "success");
    } catch (err) {
      toast(`Couldn't block: ${err instanceof Error ? err.message : err}`, "error");
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
    try {
      const { id: fileId } = await uploadOne(getApiBase(), token, file);
      const updated = await api.setServerIcon(token, serverId, fileId);
      setServers((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      toast("Server logo updated", "success");
    } catch (err) {
      toast(`Couldn't update server logo: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  function handleJoinVoice(channel: Channel, opts?: { muted?: boolean; video?: boolean }) {
    setMobileNavOpen(false);
    if (refusesCall(isDesktop(), callEnvironment())) {
      toast(VOICE_UNAVAILABLE, "error");
      return;
    }
    if (webrtc.channelId === channel.id) return;
    webrtc.joinVoice(channel.id, { video: opts?.video ?? false, muted: opts?.muted ?? false })
      .then(() => completeActivation("call"))
      .catch((err) =>
        toast(`Couldn't join the call: ${err instanceof Error ? err.message : err}`, "error")
      );
  }

  // ── Calls in DMs and group chats ──
  // Calling joins the chat's voice room, then rings the others; the call screen says
  // "Ringing…" until someone answers by joining it too.
  async function handleStartCall(channel: Channel, video: boolean) {
    setMobileNavOpen(false);
    if (refusesCall(isDesktop(), callEnvironment())) {
      toast(VOICE_UNAVAILABLE, "error");
      return;
    }
    if (webrtc.channelId === channel.id) return;
    if (webrtc.channelId) webrtc.hangUp();
    try {
      await webrtc.joinVoice(channel.id, { video, muted: false });
    } catch (err) {
      toast(`Couldn't start the call: ${err instanceof Error ? err.message : err}`, "error");
      return;
    }
    setOutgoingCall(channel.id);
    try {
      await api.startCall(token, channel.id, video);
    } catch (err) {
      setOutgoingCall(null);
      webrtcRef.current?.hangUp();
      toast(`Couldn't call: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  // Answering joins the call (the server stops the ring on your other devices).
  function handleAcceptCall(ring: IncomingRing, video: boolean) {
    setRings((prev) => nextRings(prev, { type: "stop", channelId: ring.channelId }));
    if (refusesCall(isDesktop(), callEnvironment())) {
      toast(VOICE_UNAVAILABLE, "error");
      return;
    }
    const chat = dms.find((d) => d.id === ring.channelId);
    if (chat && selectedChannelRef.current?.id !== chat.id) void handleSelectChannel(chat);
    if (webrtc.channelId === ring.channelId) return;
    if (webrtc.channelId) webrtc.hangUp();
    webrtc.joinVoice(ring.channelId, { video, muted: false })
      .then(() => completeActivation("call"))
      .catch((err) => toast(`Couldn't join the call: ${err instanceof Error ? err.message : err}`, "error"));
  }

  function handleDeclineCall(ring: IncomingRing) {
    setRings((prev) => nextRings(prev, { type: "stop", channelId: ring.channelId }));
    api.declineCall(token, ring.channelId).catch((err) =>
      toast(`Couldn't decline the call: ${err instanceof Error ? err.message : err}`, "error")
    );
  }

  /** A DM's or group chat's name, as the call screen shows it. */
  function chatCallName(channelId: string | null): string | null {
    const chat = channelId ? dms.find((d) => d.id === channelId) : undefined;
    if (!chat) return null;
    const peer = dmUsers[chat.id];
    if (chat.channel_type === "dm" && peer) return peer.display_name || peer.username;
    if (chat.name) return chat.name;
    const names = (groupMembers[chat.id] ?? [])
      .filter((m) => m.id !== currentUser?.id)
      .map((m) => m.display_name || m.username);
    return names.length ? names.join(", ") : "Group chat";
  }

  const sidebarVoiceParticipants = useMemo(() => {
    const next = new Map<string, VoiceSidebarParticipant[]>();
    for (const [channelId, members] of voiceParticipantsByChannel) {
      next.set(channelId, [...members.values()]);
    }
    if (webrtc.channelId) {
      const active = new Map<string, VoiceSidebarParticipant>(
        (next.get(webrtc.channelId) ?? []).map((p) => [p.user_id, p])
      );
      for (const peer of webrtc.participants) {
        active.set(peer.user_id, {
          user_id: peer.user_id,
          user: peer.user,
          muted: peer.muted,
          video: peer.video,
          screen: peer.screen,
          listenOnly: Boolean(peer.listenOnly),
          deafened: Boolean(peer.deafened),
        });
      }
      if (currentUser) {
        active.set(currentUser.id, {
          user_id: currentUser.id,
          user: currentUser,
          muted: webrtc.self.muted,
          video: webrtc.self.video,
          screen: webrtc.self.screen,
          listenOnly: Boolean(webrtc.self.listenOnly),
          deafened: webrtc.self.deafened,
          isSelf: true,
        });
      }
      next.set(webrtc.channelId, [...active.values()]);
    }
    for (const [channelId, members] of next) {
      members.sort((a, b) => {
        if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
        return (a.user.display_name || a.user.username).localeCompare(b.user.display_name || b.user.username);
      });
      next.set(channelId, members);
    }
    return next;
  }, [currentUser, voiceParticipantsByChannel, webrtc.channelId, webrtc.participants, webrtc.self]);

  const commandActions: CommandAction[] = [
    ...(offersInstantServers(instantServers)
      ? [
          {
            id: "action-instant-servers",
            label: "Create or manage Instant Servers",
            sub: "Hosted communities and self-hosting",
            icon: "+",
            run: () => setShowInstantServers(true),
          },
        ]
      : []),
    {
      id: "action-help",
      label: "Help & feedback",
      sub: "Service status, report a bug, ask a question",
      icon: "?",
      run: () => {
        setSettingsTab("help");
        setShowSettings(true);
      },
    },
    {
      id: "action-private-dm-link",
      label: "Create private DM link",
      sub: "One-time link or QR code to start a DM",
      icon: "⛓",
      run: () => setShowPrivateDmLink(true),
    },
    {
      id: "action-privacy-mode",
      label: privacyMode ? "Turn Privacy Mode off" : "Turn Privacy Mode on",
      sub: privacyMode ? "Restore presence, typing, activity, and seen receipts" : "Hide presence, typing, activity, and seen receipts",
      icon: privacyMode ? "👁" : "👻",
      run: () => void updatePrivacyPrefs({ ...privacyPrefs, metadataMode: !privacyMode }),
    },
  ];
  let liveVoiceTarget: { channel: Channel; names: string } | null = null;
  for (const server of servers) {
    if (liveVoiceTarget) break;
    for (const channel of server.channels) {
      if (channel.channel_type !== "voice" || channel.id === webrtc.channelId) continue;
      const members = (sidebarVoiceParticipants.get(channel.id) ?? []).filter((p) => p.user_id !== currentUser?.id);
      if (!members.length) continue;
      liveVoiceTarget = {
        channel,
        names: members.slice(0, 2).map((p) => p.user.display_name || p.user.username).join(", ") + (members.length > 2 ? ` +${members.length - 2}` : ""),
      };
      break;
    }
  }
  if (liveVoiceTarget) {
    commandActions.push({
      id: `action-join-live-voice-${liveVoiceTarget.channel.id}`,
      label: `Join ${liveVoiceTarget.names}`,
      sub: `Live in #${liveVoiceTarget.channel.name}`,
      icon: "🔊",
      run: () => handleJoinVoice(liveVoiceTarget.channel),
    });
  }

  // ⚠️ All hooks must be declared ABOVE this line — the early returns below are
  // conditional, so any hook placed after them would violate the Rules of Hooks.

  // Until the first `Ready` payload lands, show a warm splash instead of empty chrome.
  if (!currentUser) {
    return <BootSplash connStatus={connStatus} onLogout={onBackToSignIn} />;
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

  // Arrived via a one-time private DM link → token-gated preview + single-use redeem.
  if (privateDmToken) {
    return (
      <PrivateDmLinkAccept
        token={token}
        linkToken={privateDmToken}
        currentUserId={currentUser.id}
        onAccepted={handlePrivateDmAccepted}
        onDismiss={clearPrivateDmParam}
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
        onOpenSharedLink={handleOpenSharedLink}
        onPickAccent={(hex) => {
          setAccent(hex);
          pushAppearance(token);
        }}
      />
    );
  }

  const selectedServer = servers.find((s) => s.id === selectedServerId) ?? null;
  const visibleMessages = messages.filter((m) => !blockedUserIds.has(m.author.id));
  // Spaces can stop members making invite links (Create invites); the owner and managers can.
  const canInvite = can(myPerms, PERM.CREATE_INVITE) || can(myPerms, PERM.MANAGE_SERVER);
  // The open text channel's slowmode, for people who manage channels.
  const openSlowmode =
    selectedServer && selectedChannel?.channel_type === "text" && selectedChannel.server_id === selectedServer.id && can(myPerms, PERM.MANAGE_CHANNELS)
      ? () => setSlowmodeFor(selectedChannel)
      : undefined;
  const canModerateSelectedServer = selectedServer
    ? can(myPerms, PERM.MANAGE_MESSAGES) ||
      can(myPerms, PERM.BAN_MEMBERS) ||
      can(myPerms, PERM.MANAGE_SERVER) ||
      can(myPerms, PERM.MODERATE_MEMBERS)
    : false;
  const voiceChannel =
    servers.flatMap((s) => s.channels).find((c) => c.id === webrtc.channelId) ?? null;
  // The open DM or group chat, if you can call it: not a deleted account or someone you blocked.
  const callableChat =
    selectedChannel &&
    (selectedChannel.channel_type === "dm" || selectedChannel.channel_type === "group_dm") &&
    !goneDms.has(selectedChannel.id) &&
    !(selectedChannel.channel_type === "dm" && blockedUserIds.has(dmUsers[selectedChannel.id]?.id ?? ""))
      ? selectedChannel
      : null;
  // Servers with at least one unread channel get a dot on the rail.
  const unreadServerIds = new Set<string>();
  for (const s of servers) {
    if (s.channels.some((c) => shownUnread[c.id])) unreadServerIds.add(s.id);
  }


  const selectSpace = (id: string) => {
    setSelectedServerId(id || null);
    setSelectedChannel(null);
    setMessages([]);
    if (id) pluginManagerRef.current.emit("server-select", id);
  };
  // Phones: the drawer's tab bar. Home and Messages swap the drawer between your spaces and
  // your direct messages; Mentions lists chats that @mention you; You opens settings.
  const dmUnreadCount = dms.reduce((n, d) => n + (shownUnread[d.id] ?? 0), 0);
  const phoneTab: PhoneTab = showMentionsInbox ? "mentions" : selectedServerId ? "home" : "messages";
  const handlePhoneTab = (tab: PhoneTab) => {
    if (tab === "you") {
      setShowSettings(true);
      return;
    }
    setShowMentionsInbox(tab === "mentions");
    if (tab === "messages" && selectedServerId) selectSpace("");
    if (tab === "home" && !selectedServerId) {
      const last = lastSpaceIdRef.current;
      const id = last && servers.some((sv) => sv.id === last) ? last : servers[0]?.id;
      if (id) selectSpace(id);
    }
  };
  const mentionItems = [...mentions].flatMap((channelId) => {
    for (const sv of servers) {
      const ch = sv.channels.find((c) => c.id === channelId);
      if (ch) return [{ channel: ch, label: `#${ch.name}`, where: sv.name, count: shownUnread[ch.id] ?? 0 }];
    }
    const dm = dms.find((d) => d.id === channelId);
    if (dm) return [{ channel: dm, label: dm.name || dmUsers[dm.id]?.display_name || "Direct message", where: "Direct message", count: shownUnread[dm.id] ?? 0 }];
    return [];
  });

  return (
    <div className="kc-screen flex w-screen overflow-hidden">
      {/* Server + channel rails — a slide-in drawer on phones, fixed panes on desktop */}
      <div className={`kc-nav${mobileNavOpen ? " is-open" : ""}`}>
        <div className="server-sidebar">
          <ServerSidebar
            servers={servers}
            selectedId={selectedServerId}
            onSelect={(id) => {
              setShowMentionsInbox(false);
              selectSpace(id);
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
          {showMentionsInbox && (
            <MentionsInbox
              items={mentionItems}
              onOpen={(channel) => {
                setShowMentionsInbox(false);
                void handleSelectChannel(channel);
              }}
            />
          )}
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
            voiceParticipantsByChannel={sidebarVoiceParticipants}
            unread={shownUnread}
            mentionChannels={mentions}
            mutedChannelIds={mutedChannelIds}
            onOpenNotificationSettings={
              selectedServer
                ? () => {
                    setMobileNavOpen(false);
                    setNotifTarget({ type: "server", id: selectedServer.id, name: selectedServer.name, kind: "space" });
                  }
                : undefined
            }
            onOpenWebhooks={
              selectedServer
                ? () => {
                    setMobileNavOpen(false);
                    setShowWebhooks(true);
                  }
                : undefined
            }
            myStatus={myStatus}
            onSetStatus={handleSetStatus}
            myActivity={!privacyMode && currentUser ? activities.get(currentUser.id) ?? null : null}
            onSetActivity={privacyMode ? undefined : updateActivity}
            privacyMode={privacyMode}
            canManageChannels={can(myPerms, PERM.MANAGE_CHANNELS)}
            canManageServer={can(myPerms, PERM.MANAGE_SERVER)}
            onOpenCategories={() => setShowCategories(true)}
            onSelectChannel={handleSelectChannel}
            onJoinVoice={handleJoinVoice}
            onCreateChannel={handleCreateChannel}
            onSetServerIcon={handleSetServerIcon}
            onInvite={canInvite ? () => { setMobileNavOpen(false); setShowInvite(true); } : undefined}
            onCreatePrivateDmLink={() => { setMobileNavOpen(false); setShowPrivateDmLink(true); }}
            onFindPeople={() => { setMobileNavOpen(false); setShowFindPeople(true); }}
            onOpenEvents={() => { setMobileNavOpen(false); setShowEvents(true); }}
            onReportServer={selectedServer ? () => void reportTarget("server", selectedServer.id, "server") : undefined}
            onMarkRead={(ids) => void markChatsRead(ids)}
            onMarkSpaceRead={selectedServer ? markSpaceRead : undefined}
            onOpenModQueue={canModerateSelectedServer ? () => setShowModQueue(true) : undefined}
            onOpenInvites={
              selectedServer && (can(myPerms, PERM.CREATE_INVITE) || can(myPerms, PERM.MANAGE_SERVER))
                ? () => { setMobileNavOpen(false); setShowInvites(true); }
                : undefined
            }
            onOpenBans={selectedServer && can(myPerms, PERM.BAN_MEMBERS) ? () => { setMobileNavOpen(false); setShowBans(true); } : undefined}
            onOpenSlowmode={openSlowmode ? () => { setMobileNavOpen(false); openSlowmode(); } : undefined}
            onLeaveServer={async (id) => {
              const name = servers.find((s) => s.id === id)?.name ?? "the space";
              await api.leaveServer(token, id);
              dropServer(id);
              toast(`You left ${name}.`, "success");
            }}
            onDeleteServer={async (id, password) => {
              const name = servers.find((s) => s.id === id)?.name ?? "The space";
              await api.deleteServer(token, id, password);
              dropServer(id);
              toast(`${name} was deleted.`, "success");
            }}
            activationState={activation}
            showActivationChecklist={Boolean(selectedServer && currentUser && selectedServer.owner_id === currentUser.id && !activationDismissed)}
            onDismissActivationChecklist={dismissActivationChecklist}
            onLogout={onLogout}
            onOpenSettings={() => setShowSettings(true)}
          />
        </div>
        {/* Phones only (index.css): spaces, messages, mentions and you, one tap apart. */}
        <PhoneTabBar active={phoneTab} dmUnread={dmUnreadCount} mentionCount={mentions.size} onSelect={handlePhoneTab} />
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
        focusMessage={focusMessage && focusMessage.channelId === selectedChannel?.id ? focusMessage : null}
        unreadMarker={unreadMarker && unreadMarker.channelId === selectedChannel?.id ? unreadMarker : null}
        onJumpToFirstUnread={() => void jumpToFirstUnread()}
        onDismissUnreadMarker={() => setUnreadMarker(null)}
        onMarkAllRead={markEverythingRead}
        peerGone={selectedChannel?.channel_type === "dm" && goneDms.has(selectedChannel.id)}
        channel={selectedChannel}
        messages={visibleMessages}
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
        onInvite={selectedServer && canInvite ? () => setShowInvite(true) : undefined}
        typingUsers={privacyMode ? [] : typing.typingIn(selectedChannel?.id ?? "")}
        onTyping={privacyMode ? undefined : sendTyping}
        onEditMessage={handleEditMessage}
        onDeleteMessage={handleDeleteMessage}
        onPinMessage={handlePinMessage}
        onForward={(msg) => setForwarding(msg)}
        onReportMessage={(msg) => void reportTarget("message", msg.id, "message")}
        onOpenSearch={selectedServer ? () => setShowSearch(true) : undefined}
        onOpenNotificationSettings={
          selectedChannel && selectedChannel.channel_type !== "voice"
            ? () =>
                setNotifTarget(
                  selectedChannel.server_id
                    ? { type: "channel", id: selectedChannel.id, name: selectedChannel.name, kind: "channel" }
                    : {
                        type: "channel",
                        id: selectedChannel.id,
                        name: dmUsers[selectedChannel.id]?.display_name ?? (selectedChannel.name || "this chat"),
                        kind: "dm",
                      },
                )
            : undefined
        }
        chatMuted={selectedChannel ? mutedChannelIds.has(selectedChannel.id) : false}
        onOpenMembers={selectedServer ? () => setShowMembers(true) : undefined}
        onOpenDm={openDmWith}
        onBlockUser={blockUser}
        onReportUser={(user) => void reportTarget("user", user.id, "user")}
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
                if (peer) markVerified(peer, safetyNumberKeySet(peer));
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
        threadByMessage={selectedChannelThreadable ? threadByMessage : undefined}
        threadUnread={selectedChannelThreadable ? channelThreadUnread : undefined}
        onOpenThread={setOpenThread}
        onStartThread={selectedChannelThreadable ? setThreadFromMessage : undefined}
        onOpenThreads={selectedChannelThreadable ? () => setShowThreadList(true) : undefined}
        onStartCall={callableChat ? (video) => void handleStartCall(callableChat, video) : undefined}
        onJoinCall={
          callableChat
            ? () => {
                if (webrtc.channelId && webrtc.channelId !== callableChat.id) webrtc.hangUp();
                handleJoinVoice(callableChat);
              }
            : undefined
        }
        dmCall={
          callableChat
            ? {
                participants: sidebarVoiceParticipants.get(callableChat.id)?.length ?? 0,
                inCall: webrtc.channelId === callableChat.id,
              }
            : null
        }
        moderation={
          selectedServer
            ? {
                timedOutUntil: myTimeoutUntil,
                bypassSlowmode: can(myPerms, PERM.MANAGE_MESSAGES) || can(myPerms, PERM.MANAGE_CHANNELS),
              }
            : undefined
        }
        onOpenSlowmode={openSlowmode}
      />
      )}

      {/* A thread, open beside its channel (over it on a phone). */}
      {openThread && selectedChannel && openThread.parent_id === selectedChannel.id && currentUser && (
        <ThreadPanel
          key={openThread.id}
          token={token}
          thread={openThread}
          parentName={selectedChannel.name}
          currentUserId={currentUser.id}
          currentUsername={currentUser.username}
          currentUser={currentUser}
          pluginManager={pluginManagerRef.current}
          serverEmojis={serverEmojis}
          mentionables={selectedServer?.members ?? []}
          onlineUserIds={onlineUsers}
          onToast={toast}
          onClose={() => setOpenThread(null)}
          subscribe={subscribeGateway}
          onOpenDm={openDmWith}
          onBlockUser={blockUser}
          onReportUser={(user) => void reportTarget("user", user.id, "user")}
          onReportMessage={(msg) => void reportTarget("message", msg.id, "message")}
          following={followedThreads.has(openThread.id)}
          onToggleFollow={() => void toggleThreadFollow(openThread)}
          onRename={canManageThread(openThread, currentUser.id, myPerms) ? () => setRenamingThread(openThread) : undefined}
          onDelete={canManageThread(openThread, currentUser.id, myPerms) ? () => setDeletingThread(openThread) : undefined}
          archived={isArchived(openThread, nowSec)}
          initialUnread={unread[openThread.id] ?? 0}
          timedOutUntil={myTimeoutUntil}
          onRead={(lastId) => {
            if (windowHiddenRef.current) return;
            sendAck(openThread.id, lastId);
            setUnread((prev) => withoutUnread(prev, openThread.id));
          }}
        />
      )}
      {renamingThread && (
        <StartThreadDialog
          title="Rename thread"
          intro="Everyone in the channel sees the new name."
          submitLabel="Save"
          failure="Couldn't rename the thread. Try again?"
          requireName
          suggestedName={renamingThread.name}
          onCancel={() => setRenamingThread(null)}
          onStart={async (name) => {
            const renamed = await api.renameThread(token, renamingThread.id, name);
            const parent = renamed.parent_id;
            if (parent) setThreadsByParent((prev) => ({ ...prev, [parent]: upsertThread(prev[parent] ?? [], renamed) }));
            setOpenThread((prev) => (prev?.id === renamed.id ? renamed : prev));
            setRenamingThread(null);
          }}
        />
      )}
      {deletingThread && (
        <DeleteThreadDialog
          thread={deletingThread}
          onCancel={() => setDeletingThread(null)}
          onDelete={async () => {
            const gone = deletingThread;
            await api.deleteThread(token, gone.id);
            const parent = gone.parent_id;
            if (parent) setThreadsByParent((prev) => (prev[parent] ? { ...prev, [parent]: removeThread(prev[parent], gone.id) } : prev));
            setOpenThread((prev) => (prev?.id === gone.id ? null : prev));
            setUnread((prev) => withoutUnread(prev, gone.id));
            setDeletingThread(null);
            toast("Thread deleted.", "success");
          }}
        />
      )}
      {threadFromMessage && selectedChannel && (
        <StartThreadDialog
          suggestedName={defaultThreadName(threadFromMessage.content)}
          onCancel={() => setThreadFromMessage(null)}
          onStart={async (name) => {
            const thread = await api.createThread(token, selectedChannel.id, threadFromMessage.id, name);
            threadIdsRef.current.add(thread.id);
            threadParentRef.current.set(thread.id, selectedChannel.id);
            // Starting a thread follows it (the server says so too, to your other devices).
            setFollowedThreads((prev) => withFollow(prev, thread.id, thread.following ?? true));
            setThreadsByParent((prev) => ({ ...prev, [selectedChannel.id]: upsertThread(prev[selectedChannel.id] ?? [], thread) }));
            setThreadFromMessage(null);
            setOpenThread(thread);
          }}
        />
      )}
      {showThreadList && selectedChannel && (
        <ThreadListDialog
          channelName={selectedChannel.name}
          threads={channelThreads}
          unread={channelThreadUnread}
          onClose={() => setShowThreadList(false)}
          onOpen={(thread) => {
            setShowThreadList(false);
            setOpenThread(thread);
          }}
        />
      )}

      {/* Voice / video / screen-share call overlay. A WebRTC throw degrades to a
          small fallback instead of white-screening the whole app. */}
      <ErrorBoundary label="Voice call" onReset={() => webrtc.hangUp()}>
        <CallOverlay
          webrtc={webrtc}
          currentUser={currentUser}
          channelName={voiceChannel?.name ?? chatCallName(webrtc.channelId) ?? "Voice"}
          pushToTalk={voiceControls.pushToTalk}
          ringing={outgoingCall !== null && outgoingCall === webrtc.channelId}
        />
      </ErrorBoundary>

      {/* Calls ringing for you in DMs and group chats. */}
      {rings.length > 0 && (
        <div className="kc-incoming-calls">
          {rings.map((ring) => (
            <IncomingCallCard
              key={ring.channelId}
              ring={ring}
              onAccept={(video) => handleAcceptCall(ring, video)}
              onDecline={() => handleDeclineCall(ring)}
            />
          ))}
        </div>
      )}

      {/* Toast notifications */}
      <ToastStack toasts={toasts} />
      <NewDeviceAlert
        key={ownNewDevices.map((d) => d.device_id).join(",")}
        devices={ownNewDevices}
        busy={removingNewDevices}
        onKeep={() => currentUser && acknowledgeNewDevices(currentUser.id)}
        onRemove={() => void removeNewDevices()}
        lowered={Boolean(appUpdate.update)}
      />
      {appUpdate.update && (
        <UpdateBar
          version={appUpdate.update.version}
          isInstalling={appUpdate.isInstalling}
          onInstall={() => void appUpdate.install()}
          onLater={appUpdate.dismiss}
        />
      )}

      {/* Command palette — Ctrl+K or kikkacord:open-search */}
      {showCommandPalette && (
        <CommandPalette
          servers={servers}
          dms={dms}
          actions={commandActions}
          onSelectChannel={handleSelectChannel}
          onClose={() => setShowCommandPalette(false)}
        />
      )}

      {/* Create-a-server modal — replaces the old window.prompt */}
      {showCreateServer && (
        <CreateServerModal
          onCreate={createServerAndEnter}
          onJoin={handleOpenSharedLink}
          onClose={() => setShowCreateServer(false)}
        />
      )}

      {/* Instant Servers — managed/self-host lifecycle control plane. */}
      {showInstantServers && (
        <InstantServersModal
          token={token}
          onAddHome={(url) => {
            onAddHomeUrl(url);
            setShowInstantServers(false);
          }}
          onToast={toast}
          onClose={() => setShowInstantServers(false)}
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
      {showWebhooks && selectedServer && (
        <WebhooksDialog
          spaceName={selectedServer.name}
          channels={selectedServer.channels
            .filter((c) => c.channel_type === "text" && !c.parent_id)
            .sort((a, b) => a.position - b.position)
            .map((c) => ({ id: c.id, name: c.name }))}
          webhookApi={webhookApi}
          urlFor={(w) => `${getApiBase()}/webhooks/${w.id}/${w.token}`}
          fileUrl={(stored) => fileUrlOn(getFileBase(), stored)}
          onCopy={(text) => navigator.clipboard.writeText(text)}
          onClose={() => setShowWebhooks(false)}
        />
      )}
      {notifTarget && (
        <NotificationSettingsDialog
          target={notifTarget}
          setting={notifSettings[settingKey(notifTarget.type, notifTarget.id)]}
          now={nowSec}
          onSave={async (body) => {
            const saved = await api.setNotificationSetting(token, notifTarget.type, notifTarget.id, body);
            setNotifSettings((prev) => withSetting(prev, saved));
          }}
          onClose={() => setNotifTarget(null)}
        />
      )}
      {showInvite && selectedServer && (
        <InviteModal
          token={token}
          serverId={selectedServer.id}
          serverName={selectedServer.name}
          serverIconUrl={selectedServer.icon_url}
          onInviteCreated={() => completeActivation("invite")}
          onManageInvites={() => { setShowInvite(false); setShowInvites(true); }}
          onClose={() => setShowInvite(false)}
        />
      )}

      {/* One-time private DM link + QR modal */}
      {showPrivateDmLink && currentUser && (
        <PrivateDmLinkModal
          token={token}
          currentUser={currentUser}
          onToast={toast}
          onClose={() => setShowPrivateDmLink(false)}
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
          channels={selectedServer.channels}
          members={selectedServer.members}
          search={(q, page) => api.searchMessages(token, selectedServer.id, q, page)}
          assetUrl={(stored) => fileUrlOn(getFileBase(), stored)}
          onJumpToMessage={(hit) => void jumpToMessage(hit)}
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
          canTimeout={canTimeoutMembers}
          timeouts={memberTimeouts}
          onTimeout={handleTimeout}
          onRemoveTimeout={handleRemoveTimeout}
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

      {/* Moderation queue + audit log */}
      {showModQueue && selectedServer && (
        <ModerationQueueModal
          token={token}
          serverId={selectedServer.id}
          channelName={(id) => selectedServer.channels.find((c) => c.id === id)?.name}
          onToast={toast}
          onClose={() => setShowModQueue(false)}
        />
      )}

      {/* A channel's slowmode */}
      {slowmodeFor && (
        <SlowmodeDialog
          channelName={slowmodeFor.name}
          seconds={slowmodeFor.slowmode_seconds ?? 0}
          onSave={async (seconds) => {
            await api.setSlowmode(token, slowmodeFor.id, seconds);
            setSlowmodeFor(null);
            toast(seconds ? `Slowmode in #${slowmodeFor.name}: ${slowmodeLabel(seconds).toLowerCase()}` : `Slowmode off in #${slowmodeFor.name}`, "success");
          }}
          onClose={() => setSlowmodeFor(null)}
        />
      )}

      {/* The space's invite links, and pausing them */}
      {showInvites && selectedServer && (
        <InvitesDialog
          canManageServer={can(myPerms, PERM.MANAGE_SERVER)}
          api={{
            list: () => api.listInvites(token, selectedServer.id),
            revoke: (code) => api.revokeInvite(token, code),
            getSettings: () => api.getInviteSettings(token, selectedServer.id),
            updateSettings: (patch) => api.updateInviteSettings(token, selectedServer.id, patch),
          }}
          onClose={() => setShowInvites(false)}
        />
      )}

      {/* Who is banned, and lifting bans */}
      {showBans && selectedServer && (
        <BansDialog
          api={{
            list: () => api.listBans(token, selectedServer.id),
            unban: (userId) => api.unbanMember(token, selectedServer.id, userId),
          }}
          onClose={() => setShowBans(false)}
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
          dms={dms}
          initialTab={settingsTab}
          privacyPrefs={privacyPrefs}
          onPrivacyPrefsChange={updatePrivacyPrefs}
          onClose={() => { setShowSettings(false); setSettingsTab("appearance"); }}
          onToast={toast}
          onCurrentUserUpdate={handleCurrentUserUpdate}
          onSignOutEverywhere={signOutEverywhere}
          onTokenChange={onTokenChange}
          onAccountDeleted={currentUser ? () => onAccountDeleted(currentUser.id) : undefined}
        />
      )}
    </div>
  );
}
