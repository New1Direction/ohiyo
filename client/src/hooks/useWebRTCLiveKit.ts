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
import { getGroupEpoch } from "../lib/senderKeys";
import {
  generateRoomKey,
  encodeVoiceEnvelope,
  decodeVoiceEnvelope,
  shouldAdopt,
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

  // Voice E2EE: the FrameCryptor key provider + worker for the active call, and the
  // converged per-(channel, epoch) room key we currently hold.
  const keyProviderRef = useRef<ExternalE2EEKeyProvider | null>(null);
  const e2eeWorkerRef = useRef<Worker | null>(null);
  const voiceKeysRef = useRef<Map<string, { key: Uint8Array; sourceId: string }>>(new Map());

  // Encrypt our current room key to each recipient (pairwise Signal) and relay it, so
  // call participants converge on one shared FrameCryptor key. The server forwards only
  // ciphertext.
  const distributeMyVoiceKey = useCallback(async (cid: string, recipientIds: string[]) => {
    const myId = cbRef.current.currentUserId;
    const vk = voiceKeysRef.current.get(`${cid}:${getGroupEpoch(cid)}`);
    if (!vk) return;
    const env = encodeVoiceEnvelope(vk.key, vk.sourceId);
    const envelopes: Record<string, string> = {};
    for (const uid of recipientIds) {
      if (uid === myId) continue;
      const ct = await encryptFor(tokenRef.current, uid, env);
      if (ct) envelopes[uid] = ct;
    }
    if (Object.keys(envelopes).length) await api.distributeVoiceKey(tokenRef.current, cid, envelopes);
  }, []);

  const toVP = (p: RemoteParticipant): VoiceParticipant => ({
    user_id: p.identity,
    user: { id: p.identity, username: p.identity, display_name: p.name || p.identity, avatar_url: null } as PublicUser,
    muted: !p.isMicrophoneEnabled,
    video: p.isCameraEnabled,
    screen: p.isScreenShareEnabled,
  });

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
    // Burn the E2EE worker + key provider for the ended call.
    e2eeWorkerRef.current?.terminate();
    e2eeWorkerRef.current = null;
    keyProviderRef.current = null;
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

        // Ensure a room key for this call, scoped to the channel + its current rekey
        // epoch. If we're first in we mint it; otherwise gossip converges everyone onto
        // the lowest-id participant's key (see onVoiceKey).
        const cacheKey = `${cid}:${getGroupEpoch(cid)}`;
        let vk = voiceKeysRef.current.get(cacheKey);
        if (!vk) {
          vk = { key: generateRoomKey(), sourceId: cbRef.current.currentUserId };
          voiceKeysRef.current.set(cacheKey, vk);
        }

        const roomOpts: RoomOptions = { adaptiveStream: true, dynacast: true };
        if (E2EE_ENABLED) {
          // ExternalE2EEKeyProvider runs HKDF over the raw 32 bytes internally — no
          // hand-rolled media crypto. The worker does the actual frame (de/en)cryption.
          const keyProvider = new ExternalE2EEKeyProvider();
          await keyProvider.setKey(new Uint8Array(vk.key).buffer);
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
          .on(RoomEvent.ParticipantDisconnected, refresh)
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
    [refresh, refreshLocal, reset, distributeMyVoiceKey]
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

  const toggleVideo = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    void room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled).then(() => {
      refreshLocal();
      pushMeta();
    });
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
  // When someone joins our active call, push them our room key so they converge fast
  // (they also announce theirs; the lowest-id key wins — see onVoiceKey).
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
      if (!E2EE_ENABLED || !s.joined) return;
      if (s.channel_id !== channelRef.current) return;
      if (s.user_id === cbRef.current.currentUserId) return;
      void distributeMyVoiceKey(s.channel_id, [s.user_id]);
    },
    [distributeMyVoiceKey]
  );

  // A peer announced their voice key. Adopt it if it wins (smaller source id); if ours
  // wins, reply with ours so they converge. setKey re-keys the live FrameCryptor.
  const onVoiceKey = useCallback(
    async (channelId: string, fromUserId: string, envelope: string) => {
      if (!E2EE_ENABLED || channelId !== channelRef.current) return;
      const plain = await decryptFrom(fromUserId, envelope);
      if (!plain) return;
      const parsed = decodeVoiceEnvelope(plain);
      if (!parsed) return;
      const cacheKey = `${channelId}:${getGroupEpoch(channelId)}`;
      const cur = voiceKeysRef.current.get(cacheKey) ?? null;
      if (shouldAdopt(cur?.sourceId ?? null, parsed.sourceId)) {
        voiceKeysRef.current.set(cacheKey, { key: parsed.key, sourceId: parsed.sourceId });
        if (keyProviderRef.current) await keyProviderRef.current.setKey(new Uint8Array(parsed.key).buffer);
      } else if (cur && shouldReplyWithOurs(cur.sourceId, parsed.sourceId)) {
        void distributeMyVoiceKey(channelId, [fromUserId]);
      }
    },
    [distributeMyVoiceKey]
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
