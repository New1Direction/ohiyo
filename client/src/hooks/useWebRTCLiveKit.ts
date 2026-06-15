import { useCallback, useEffect, useRef, useState } from "react";
import type { Room, RemoteParticipant } from "livekit-client";
import type { PublicUser } from "../api";
import { api } from "../api";
import type { VoicePeer } from "../gateway";
import { usePeerQuality } from "../webrtc/usePeerQuality";
import type { ScreenSharePresetId } from "../webrtc/screenShare";
import type { CallState, VoiceParticipant, WebRTCCallbacks, UseWebRTCReturn } from "./useWebRTC";

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
        const { Room, RoomEvent } = await import("livekit-client");
        const room = new Room({ adaptiveStream: true, dynacast: true });
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
        await room.localParticipant.setMicrophoneEnabled(true);
        if (opts?.video) await room.localParticipant.setCameraEnabled(true);
        refresh();
        refreshLocal();
        setCallState("connected");
      } catch (e) {
        reset();
        throw e;
      }
    },
    [refresh, refreshLocal, reset]
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
    };
  }, []);

  // Gateway-driven callbacks are no-ops in SFU mode (LiveKit does its own signaling).
  const onRoster = useCallback((_cid: string, _peers: VoicePeer[]) => {}, []);
  const onPeerSignal = useCallback(
    async (_sig: { from: string; kind: string; payload: string }) => {},
    []
  );
  const onVoiceState = useCallback(
    (_s: {
      channel_id: string;
      user_id: string;
      user: PublicUser;
      joined: boolean;
      muted: boolean;
      video: boolean;
      screen: boolean;
    }) => {},
    []
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
  };
}
