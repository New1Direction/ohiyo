import { useCallback, useEffect, useRef, useState } from "react";
import type { Room, RemoteParticipant, RoomOptions, ExternalE2EEKeyProvider } from "livekit-client";
// Pre-built E2EE worker shipped with livekit-client (exposed via its package exports);
// Vite emits it as a separate asset and gives us its URL. Loaded only when a Worker is
// actually constructed (on join).
import e2eeWorkerUrl from "livekit-client/e2ee-worker?url";
import type { PublicUser } from "../api";
import { api } from "../api";
import type { VoicePeer } from "../gateway";
import { encryptFor, decryptFrom } from "../lib/signal";
import {
  generateRoomKey,
  encodeVoiceEnvelope,
  decodeVoiceEnvelope,
  pickCanonical,
  shouldReplyWithOurs,
} from "../lib/voiceKey";
import { usePeerQuality } from "../webrtc/usePeerQuality";
import type { ScreenSharePresetId } from "../webrtc/screenShare";
import type { CallState, VoiceParticipant, WebRTCCallbacks, UseWebRTCReturn } from "./useWebRTC";

// Media E2EE (FrameCryptor) is on by default whenever the SFU is on; set
// VITE_LIVEKIT_E2EE=false to disable (e.g. if a deployment's webview lacks the
// Encoded-Transform API the worker needs).
const E2EE_ENABLED = import.meta.env.VITE_LIVEKIT_E2EE !== "false";

/**
 * LiveKit (SFU) voice engine — a drop-in replacement for `useWebRTC` returning the
 * SAME shape, so `CallOverlay` and `App` are unchanged. Each client sends its media
 * once to LiveKit (no N×N mesh), lifting the ~4-5 person ceiling.
 *
 * Presence still rides the gateway (sendJoin/Leave/Meta) so "who's in voice" and the
 * "Join" button keep working; only the *media* path is LiveKit.
 *
 * Feature-flagged off by default. Compiles + typechecks; a real multi-party call
 * needs a running LiveKit instance (see infra/livekit/) to verify end-to-end.
 */
export function useWebRTCLiveKit(cb: WebRTCCallbacks, token: string): UseWebRTCReturn {
  const [callState, setCallState] = useState<CallState>("idle");
  const [channelId, setChannelId] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [participants, setParticipants] = useState<Map<string, VoiceParticipant>>(new Map());
  const [self, setSelf] = useState({ muted: false, video: false, screen: false });

  const roomRef = useRef<Room | null>(null);
  const channelRef = useRef<string | null>(null);
  // Keep callbacks/token current without rebuilding the stable handlers below.
  const cbRef = useRef(cb);
  cbRef.current = cb;
  const tokenRef = useRef(token);
  tokenRef.current = token;

  // Voice E2EE: the FrameCryptor key provider + worker for the active call, our OWN room
  // key per channel (what we announce), and the per-participant own-keys we've collected
  // (sourceId → key, including ours). The key we feed the FrameCryptor is the smallest-id
  // entry; evicting a participant on leave rotates it automatically.
  const keyProviderRef = useRef<ExternalE2EEKeyProvider | null>(null);
  const e2eeWorkerRef = useRef<Worker | null>(null);
  const myVoiceKeyRef = useRef<Map<string, Uint8Array>>(new Map());
  const peerVoiceKeysRef = useRef<Map<string, Map<string, Uint8Array>>>(new Map());
  // LiveKit gives identity/name only. Preserve the richer Ohiyo PublicUser from
  // gateway VoiceState so call tiles can show real profile pictures.
  const voiceUsersRef = useRef<Map<string, PublicUser>>(new Map());

  // Our own key for a channel (minted once per call), also recorded in the collected set.
  const ensureMyVoiceKey = useCallback((cid: string): Uint8Array => {
    let mine = myVoiceKeyRef.current.get(cid);
    if (!mine) {
      mine = generateRoomKey();
      myVoiceKeyRef.current.set(cid, mine);
    }
    let collected = peerVoiceKeysRef.current.get(cid);
    if (!collected) {
      collected = new Map();
      peerVoiceKeysRef.current.set(cid, collected);
    }
    collected.set(cbRef.current.currentUserId, mine);
    return mine;
  }, []);

  // Feed the live FrameCryptor the canonical (smallest-id) key from what we've collected.
  const applyCanonicalKey = useCallback(async (cid: string) => {
    if (cid !== channelRef.current || !keyProviderRef.current) return;
    const canonical = pickCanonical(peerVoiceKeysRef.current.get(cid) ?? new Map());
    if (canonical) await keyProviderRef.current.setKey(new Uint8Array(canonical.key).buffer);
  }, []);

  // Encrypt OUR OWN key to each recipient (pairwise Signal) and relay it. The envelope's
  // source id is always us, so a relay can never announce another member's key.
  const distributeMyVoiceKey = useCallback(async (cid: string, recipientIds: string[]) => {
    const myId = cbRef.current.currentUserId;
    const mine = myVoiceKeyRef.current.get(cid);
    if (!mine) return;
    const env = encodeVoiceEnvelope(mine, myId);
    const envelopes: Record<string, string> = {};
    for (const uid of recipientIds) {
      if (uid === myId) continue;
      const ct = await encryptFor(tokenRef.current, uid, env);
      if (ct) envelopes[uid] = ct;
    }
    if (Object.keys(envelopes).length) await api.distributeVoiceKey(tokenRef.current, cid, envelopes);
  }, []);

  // A participant left the call: drop their key and rotate to the next canonical one, so
  // they can't decrypt anything sent afterward (forward secrecy on leave).
  const evictVoiceKey = useCallback(
    (cid: string, userId: string) => {
      peerVoiceKeysRef.current.get(cid)?.delete(userId);
      void applyCanonicalKey(cid);
    },
    [applyCanonicalKey]
  );

  const toVP = (p: RemoteParticipant): VoiceParticipant => {
    const known = voiceUsersRef.current.get(p.identity);
    return {
      user_id: p.identity,
      user: known ?? ({ id: p.identity, username: p.identity, display_name: p.name || p.identity, avatar_url: null } as PublicUser),
      muted: !p.isMicrophoneEnabled,
      video: p.isCameraEnabled,
      screen: p.isScreenShareEnabled,
    };
  };

  // Rebuild remote participant + stream maps from the room's current state.
  const refresh = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    const parts = new Map<string, VoiceParticipant>();
    const streams = new Map<string, MediaStream>();
    for (const p of room.remoteParticipants.values()) {
      parts.set(p.identity, toVP(p));
      const ms = new MediaStream();
      for (const pub of p.trackPublications.values()) {
        const t = pub.track?.mediaStreamTrack;
        if (t) ms.addTrack(t);
      }
      if (ms.getTracks().length) streams.set(p.identity, ms);
    }
    setParticipants(parts);
    setRemoteStreams(streams);
  }, []);

  const refreshLocal = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    const ms = new MediaStream();
    for (const pub of room.localParticipant.trackPublications.values()) {
      const t = pub.track?.mediaStreamTrack;
      if (t) ms.addTrack(t);
    }
    setLocalStream(ms.getTracks().length ? ms : null);
    setSelf({
      muted: !room.localParticipant.isMicrophoneEnabled,
      video: room.localParticipant.isCameraEnabled,
      screen: room.localParticipant.isScreenShareEnabled,
    });
  }, []);

  const reset = useCallback(() => {
    // Burn the E2EE worker + key provider and all room keys for the ended call.
    e2eeWorkerRef.current?.terminate();
    e2eeWorkerRef.current = null;
    keyProviderRef.current = null;
    myVoiceKeyRef.current.clear();
    peerVoiceKeysRef.current.clear();
    setCallState("idle");
    setChannelId(null);
    channelRef.current = null;
    setLocalStream(null);
    setRemoteStreams(new Map());
    setParticipants(new Map());
    setSelf({ muted: false, video: false, screen: false });
  }, []);

  const joinVoice = useCallback(
    async (cid: string, opts?: { video?: boolean }) => {
      channelRef.current = cid;
      setChannelId(cid);
      setCallState("joining");
      // Announce presence over the gateway (drives the member-list "in voice" + Join).
      cbRef.current.sendJoin(cid, false, opts?.video ?? false);
      try {
        const { token: lkToken, url } = await api.getLiveKitToken(tokenRef.current, cid);
        // Lazy-load the SDK so it stays out of the main bundle (fetched on first join).
        const { Room, RoomEvent, ExternalE2EEKeyProvider } = await import("livekit-client");

        // Mint our own room key for this call (the only key we announce).
        const myKey = ensureMyVoiceKey(cid);

        const roomOpts: RoomOptions = { adaptiveStream: true, dynacast: true };
        if (E2EE_ENABLED) {
          // ExternalE2EEKeyProvider runs HKDF over the raw 32 bytes internally — no
          // hand-rolled media crypto. The worker does the actual frame (de/en)cryption.
          const keyProvider = new ExternalE2EEKeyProvider();
          await keyProvider.setKey(new Uint8Array(myKey).buffer);
          const worker = new Worker(e2eeWorkerUrl, { type: "module" });
          keyProviderRef.current = keyProvider;
          e2eeWorkerRef.current = worker;
          roomOpts.e2ee = { keyProvider, worker };
        }
        const room = new Room(roomOpts);
        roomRef.current = room;
        room
          .on(RoomEvent.TrackSubscribed, refresh)
          .on(RoomEvent.TrackUnsubscribed, refresh)
          .on(RoomEvent.ParticipantConnected, refresh)
          // On leave, evict the departed participant's key (rotates the room key) too.
          .on(RoomEvent.ParticipantDisconnected, (p) => {
            evictVoiceKey(cid, p.identity);
            refresh();
          })
          .on(RoomEvent.TrackMuted, refresh)
          .on(RoomEvent.TrackUnmuted, refresh)
          .on(RoomEvent.LocalTrackPublished, refreshLocal)
          .on(RoomEvent.LocalTrackUnpublished, refreshLocal)
          .on(RoomEvent.Disconnected, reset);
        await room.connect(url, lkToken);
        if (E2EE_ENABLED) await room.setE2EEEnabled(true);
        await room.localParticipant.setMicrophoneEnabled(true);
        if (opts?.video) await room.localParticipant.setCameraEnabled(true);
        refresh();
        refreshLocal();
        setCallState("connected");
        // Announce our key to everyone already in the room so we all converge.
        if (E2EE_ENABLED) {
          const recips = [...room.remoteParticipants.values()].map((p) => p.identity);
          if (recips.length) void distributeMyVoiceKey(cid, recips);
        }
      } catch (e) {
        reset();
        throw e;
      }
    },
    [refresh, refreshLocal, reset, ensureMyVoiceKey, distributeMyVoiceKey, evictVoiceKey]
  );

  const hangUp = useCallback(() => {
    const cid = channelRef.current;
    if (cid) cbRef.current.sendLeave(cid);
    void roomRef.current?.disconnect();
    roomRef.current = null;
    reset();
  }, [reset]);

  const pushMeta = useCallback(() => {
    const room = roomRef.current;
    const cid = channelRef.current;
    if (!room || !cid) return;
    cbRef.current.sendMeta(
      cid,
      !room.localParticipant.isMicrophoneEnabled,
      room.localParticipant.isCameraEnabled,
      room.localParticipant.isScreenShareEnabled
    );
  }, []);

  const toggleAudio = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    void room.localParticipant
      .setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled)
      .then(() => {
        refreshLocal();
        pushMeta();
      });
  }, [refreshLocal, pushMeta]);

  const toggleVideo = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    await room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled);
    refreshLocal();
    pushMeta();
  }, [refreshLocal, pushMeta]);

  const toggleScreenShare = useCallback(
    async (opts?: { presetId?: ScreenSharePresetId; wantAudio?: boolean }) => {
      const room = roomRef.current;
      if (!room) return;
      await room.localParticipant.setScreenShareEnabled(!room.localParticipant.isScreenShareEnabled, {
        audio: opts?.wantAudio ?? false,
      });
      refreshLocal();
      pushMeta();
    },
    [refreshLocal, pushMeta]
  );

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      void roomRef.current?.disconnect();
      roomRef.current = null;
      e2eeWorkerRef.current?.terminate();
      e2eeWorkerRef.current = null;
    };
  }, []);

  // Gateway-driven callbacks: LiveKit does its own media signaling, so roster/peer
  // signal are no-ops. VoiceState + VoiceKey drive the E2EE key gossip.
  const onRoster = useCallback((_cid: string, _peers: VoicePeer[]) => {}, []);
  const onPeerSignal = useCallback(
    async (_sig: { from: string; kind: string; payload: string }) => {},
    []
  );
  // When someone joins our active call, push them our room key so they can converge
  // (they also announce theirs; everyone uses the smallest-id key — see onVoiceKey).
  const onVoiceState = useCallback(
    (s: {
      channel_id: string;
      user_id: string;
      user: PublicUser;
      joined: boolean;
      muted: boolean;
      video: boolean;
      screen: boolean;
    }) => {
      if (s.channel_id !== channelRef.current) return;
      if (s.joined) voiceUsersRef.current.set(s.user_id, s.user);
      else voiceUsersRef.current.delete(s.user_id);
      refresh();

      if (!E2EE_ENABLED || !s.joined) return;
      if (s.user_id === cbRef.current.currentUserId) return;
      ensureMyVoiceKey(s.channel_id);
      void distributeMyVoiceKey(s.channel_id, [s.user_id]);
    },
    [ensureMyVoiceKey, distributeMyVoiceKey, refresh]
  );

  // A peer announced THEIR OWN key. Authenticate the claimed source against the
  // server-stamped sender, record it, then re-key the FrameCryptor to the smallest-id
  // key we now hold. If our own key wins, reply so the (higher-id) sender learns it.
  const onVoiceKey = useCallback(
    async (channelId: string, fromUserId: string, envelope: string) => {
      if (!E2EE_ENABLED || channelId !== channelRef.current) return;
      const plain = await decryptFrom(fromUserId, envelope);
      if (!plain) return;
      const parsed = decodeVoiceEnvelope(plain);
      if (!parsed) return;
      // The envelope's claimed source MUST be the authenticated sender. Otherwise a
      // participant could announce sourceId="000…" (lexicographically smallest) to make
      // everyone converge onto a key they alone control — a full E2EE hijack.
      if (parsed.sourceId !== fromUserId) return;
      let collected = peerVoiceKeysRef.current.get(channelId);
      if (!collected) {
        collected = new Map();
        peerVoiceKeysRef.current.set(channelId, collected);
      }
      collected.set(fromUserId, parsed.key);
      await applyCanonicalKey(channelId);
      if (shouldReplyWithOurs(cbRef.current.currentUserId, fromUserId)) {
        void distributeMyVoiceKey(channelId, [fromUserId]);
      }
    },
    [applyCanonicalKey, distributeMyVoiceKey]
  );

  // No RTCPeerConnections in SFU mode → empty quality (LiveKit surfaces its own).
  const quality = usePeerQuality(
    useCallback(() => new Map<string, RTCPeerConnection>(), []),
    []
  );

  return {
    callState,
    channelId,
    localStream,
    remoteStreams,
    participants: [...participants.values()],
    self,
    quality,
    joinVoice,
    hangUp,
    toggleAudio,
    toggleVideo,
    toggleScreenShare,
    onRoster,
    onPeerSignal,
    onVoiceState,
    onVoiceKey,
  };
}
