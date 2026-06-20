import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicUser } from "../api";
import type { VoicePeer } from "../gateway";
import { rtcConfig, applyVideoProfile, CAMERA_720P, MUSIC_AUDIO } from "../webrtc/video";
import { tuneOpusSdp, raiseAudioBitrate } from "../webrtc/sdp";
import { applyVideoCodecPreference } from "../webrtc/codecs";
import {
  captureDisplay,
  getPreset,
  applySenderBitrate,
  DEFAULT_PRESET_ID,
  type ScreenSharePresetId,
} from "../webrtc/screenShare";
import { usePeerQuality, type PeerQuality } from "../webrtc/usePeerQuality";

// Fallback when /ice-servers can't be reached. STUN works on LAN/most networks.
const FALLBACK_ICE: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

export type CallState = "idle" | "joining" | "connected";

export type VoiceParticipant = {
  user_id: string;
  user: PublicUser;
  muted: boolean;
  video: boolean;
  screen: boolean;
};

type PeerEntry = {
  pc: RTCPeerConnection;
  pending: RTCIceCandidateInit[];
  needsRenegotiation?: boolean;
};

export type WebRTCCallbacks = {
  currentUserId: string;
  getIceServers: () => Promise<RTCIceServer[]>;
  sendJoin: (channelId: string, muted: boolean, video: boolean) => void;
  sendLeave: (channelId: string) => void;
  sendMeta: (channelId: string, muted: boolean, video: boolean, screen: boolean) => void;
  sendSignal: (to: string, kind: string, payload: string) => void;
};

/** A black 1-frame video track, so every peer always has a video sender to
 *  replaceTrack() on — lets camera + screen-share work without renegotiation. */
function blankVideoTrack(): MediaStreamTrack {
  const canvas = Object.assign(document.createElement("canvas"), { width: 320, height: 240 });
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const stream = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream }).captureStream(1);
  const track = stream.getVideoTracks()[0];
  track.enabled = false;
  return track;
}

export function useWebRTC(cb: WebRTCCallbacks) {
  const [callState, setCallState] = useState<CallState>("idle");
  const [channelId, setChannelId] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(new Map());
  const [participants, setParticipants] = useState<Map<string, VoiceParticipant>>(new Map());
  const [self, setSelf] = useState({ muted: false, video: false, screen: false });

  const pcsRef = useRef<Map<string, PeerEntry>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenShareBitrateRef = useRef<number | null>(null);
  const screenAudioSendersRef = useRef<Map<string, RTCRtpSender>>(new Map());
  const iceServersRef = useRef<RTCIceServer[]>(FALLBACK_ICE);
  const channelRef = useRef<string | null>(null);
  const hasRealCameraRef = useRef(false);
  const renegotiateRef = useRef<((peerId: string) => void) | null>(null);

  const cbRef = useRef(cb);
  cbRef.current = cb;
  const selfRef = useRef(self);
  selfRef.current = self;

  // Dev-only test seam: lets E2E tests inspect live peer-connection state.
  if (import.meta.env.DEV && typeof window !== "undefined") {
    (window as unknown as { __kkCall?: () => unknown }).__kkCall = () =>
      [...pcsRef.current.entries()].map(([id, e]) => {
        const sdp = e.pc.localDescription?.sdp ?? "";
        return {
          id,
          conn: e.pc.connectionState,
          ice: e.pc.iceConnectionState,
          recvTracks: e.pc.getReceivers().filter((r) => r.track && r.track.readyState === "live").map((r) => r.track.kind),
          sendTracks: e.pc.getSenders().map((s) => s.track).filter((track): track is MediaStreamTrack => !!track && track.readyState === "live").map((track) => track.kind),
          remoteStreamTracks: [...remoteStreams.entries()].map(([peerId, stream]) => ({
            peerId,
            tracks: stream.getTracks().filter((track) => track.readyState === "live").map((track) => track.kind),
          })),
          localTracks: localStreamRef.current?.getTracks().filter((track) => track.readyState === "live").map((track) => track.kind) ?? [],
          opusFmtp: sdp.match(/^a=fmtp:\d+ .*stereo=1.*$/im)?.[0] ?? null,
          videoCodecs: [...sdp.matchAll(/^a=rtpmap:\d+ (AV1|VP9|VP8|H264)\/90000/gim)].map((m) => m[1]),
        };
      });
  }

  // ── Peer connection plumbing ──────────────────────────────────────────────
  const createPeer = useCallback((peerId: string, initiator: boolean): PeerEntry => {
    const existing = pcsRef.current.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection(rtcConfig(iceServersRef.current));
    const entry: PeerEntry = { pc, pending: [] };
    pcsRef.current.set(peerId, entry);

    const ls = localStreamRef.current;
    if (ls) for (const track of ls.getTracks()) pc.addTrack(track, ls);

    // If someone joins while we are already screen sharing, the new peer is born
    // after the original replaceTrack() calls. Wire that peer to the active screen
    // immediately so they do not receive the stale camera/blank video track.
    const activeScreenVideo = screenStreamRef.current?.getVideoTracks()[0] ?? null;
    const activeScreenAudio = screenStreamRef.current?.getAudioTracks()[0] ?? null;
    if (activeScreenVideo && activeScreenVideo.readyState === "live") {
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) {
        void sender.replaceTrack(activeScreenVideo).then(() => {
          const bitrate = screenShareBitrateRef.current;
          if (bitrate) void applySenderBitrate(sender, bitrate);
        }).catch(() => {});
      }
    }
    if (activeScreenAudio && activeScreenAudio.readyState === "live") {
      try {
        const sender = pc.addTrack(activeScreenAudio, screenStreamRef.current!);
        screenAudioSendersRef.current.set(peerId, sender);
      } catch { /* ignore */ }
    }

    pc.onicecandidate = (e) => {
      if (e.candidate) cbRef.current.sendSignal(peerId, "candidate", JSON.stringify(e.candidate.toJSON()));
    };
    // Rebuild this peer's stream from its currently-LIVE received tracks
    // (camera/screen video + mic + screen audio). Re-runs when a track arrives
    // or ends, so screen audio appears and dead tracks are dropped cleanly.
    const rebuildRemote = () => {
      setRemoteStreams((prev) => {
        const tracks = pc
          .getReceivers()
          .map((r) => r.track)
          .filter((t): t is MediaStreamTrack => !!t && t.readyState === "live");
        return new Map(prev).set(peerId, new MediaStream(tracks));
      });
    };
    pc.ontrack = (e) => {
      e.track.addEventListener("ended", rebuildRemote);
      rebuildRemote();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        // Crank up quality once connected. Mesh: clamp by peer count.
        const peerCount = pcsRef.current.size + 1;
        void applyVideoProfile(pc, CAMERA_720P, "maintain-framerate", peerCount);
        void raiseAudioBitrate(pc);
      } else if (pc.connectionState === "failed") {
        try { pc.restartIce(); } catch { /* older browsers */ }
      }
    };
    // Flush a deferred renegotiation once the peer returns to a stable state.
    pc.onsignalingstatechange = () => {
      if (pc.signalingState === "stable" && entry.needsRenegotiation) {
        entry.needsRenegotiation = false;
        renegotiateRef.current?.(peerId);
      }
    };

    if (initiator) {
      (async () => {
        try {
          applyVideoCodecPreference(pc); // before createOffer
          const offer = await pc.createOffer();
          await pc.setLocalDescription({ type: offer.type, sdp: tuneOpusSdp(offer.sdp!) });
          cbRef.current.sendSignal(peerId, "offer", JSON.stringify(pc.localDescription));
        } catch (err) {
          console.warn("[webrtc] offer failed", err);
        }
      })();
    }
    return entry;
  }, []);

  const closePeer = useCallback((peerId: string) => {
    const entry = pcsRef.current.get(peerId);
    if (entry) {
      for (const r of entry.pc.getReceivers()) r.track?.stop();
      try { entry.pc.close(); } catch { /* ignore */ }
      pcsRef.current.delete(peerId);
    }
    screenAudioSendersRef.current.delete(peerId);
    setRemoteStreams((prev) => {
      if (!prev.has(peerId)) return prev;
      const next = new Map(prev);
      next.delete(peerId);
      return next;
    });
  }, []);

  /** Re-offer a peer (used when screen-audio add/remove changes the m-line set).
   *  If the peer isn't stable yet, defer — onsignalingstatechange retries. */
  const renegotiate = useCallback(async (peerId: string) => {
    const entry = pcsRef.current.get(peerId);
    if (!entry) return;
    if (entry.pc.signalingState !== "stable") {
      entry.needsRenegotiation = true;
      return;
    }
    try {
      applyVideoCodecPreference(entry.pc);
      const offer = await entry.pc.createOffer();
      if (entry.pc.signalingState !== "stable") {
        entry.needsRenegotiation = true; // raced during the await
        return;
      }
      await entry.pc.setLocalDescription({ type: offer.type, sdp: tuneOpusSdp(offer.sdp!) });
      cbRef.current.sendSignal(peerId, "offer", JSON.stringify(entry.pc.localDescription));
    } catch (e) {
      entry.needsRenegotiation = true;
      console.warn("[webrtc] renegotiate failed; will retry on stable", e);
    }
  }, []);
  renegotiateRef.current = renegotiate;

  // ── Gateway-driven handlers (wired in App.tsx) ────────────────────────────
  const onRoster = useCallback((cid: string, peers: VoicePeer[]) => {
    if (channelRef.current !== cid) return;
    setParticipants((prev) => {
      const next = new Map(prev);
      for (const p of peers) {
        next.set(p.user_id, { user_id: p.user_id, user: p.user, muted: p.muted, video: p.video, screen: p.screen });
      }
      return next;
    });
    for (const p of peers) createPeer(p.user_id, true);
    setCallState("connected");
  }, [createPeer]);

  const onPeerSignal = useCallback(async (sig: { from: string; kind: string; payload: string }) => {
    const { from, kind, payload } = sig;
    if (kind === "offer") {
      const entry = pcsRef.current.get(from) ?? createPeer(from, false);
      // Perfect-negotiation collision handling: if we're mid-offer when a peer's
      // offer arrives (rare glare, e.g. ICE restart), the "polite" peer rolls
      // back and accepts; the "impolite" peer ignores. Deterministic by user id.
      const collision = entry.pc.signalingState !== "stable";
      const polite = cbRef.current.currentUserId > from;
      if (collision) {
        if (!polite) return;
        try { await entry.pc.setLocalDescription({ type: "rollback" }); } catch { return; }
      }
      await entry.pc.setRemoteDescription(JSON.parse(payload));
      for (const c of entry.pending.splice(0)) await entry.pc.addIceCandidate(c).catch(() => {});
      applyVideoCodecPreference(entry.pc); // before createAnswer
      const answer = await entry.pc.createAnswer();
      await entry.pc.setLocalDescription({ type: answer.type, sdp: tuneOpusSdp(answer.sdp!) });
      cbRef.current.sendSignal(from, "answer", JSON.stringify(entry.pc.localDescription));
    } else if (kind === "answer") {
      const entry = pcsRef.current.get(from);
      if (!entry) return;
      await entry.pc.setRemoteDescription(JSON.parse(payload));
      for (const c of entry.pending.splice(0)) await entry.pc.addIceCandidate(c).catch(() => {});
    } else if (kind === "candidate") {
      const entry = pcsRef.current.get(from);
      if (!entry) return;
      const cand: RTCIceCandidateInit = JSON.parse(payload);
      if (entry.pc.remoteDescription) await entry.pc.addIceCandidate(cand).catch(() => {});
      else entry.pending.push(cand);
    }
  }, [createPeer]);

  const onVoiceState = useCallback((s: {
    channel_id: string; user_id: string; user: PublicUser; joined: boolean; muted: boolean; video: boolean; screen: boolean;
  }) => {
    if (channelRef.current !== s.channel_id) return;
    if (s.user_id === cbRef.current.currentUserId) return;
    if (s.joined) {
      setParticipants((prev) => new Map(prev).set(s.user_id, {
        user_id: s.user_id, user: s.user, muted: s.muted, video: s.video, screen: s.screen,
      }));
    } else {
      closePeer(s.user_id);
      setParticipants((prev) => {
        const next = new Map(prev);
        next.delete(s.user_id);
        return next;
      });
    }
  }, [closePeer]);

  // ── Local media acquisition ───────────────────────────────────────────────
  const acquireMicStream = useCallback(async (): Promise<MediaStream> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser cannot access a microphone. Try Chrome, Edge, or the Ohiyo desktop app.");
    }

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: MUSIC_AUDIO });
    } catch (musicErr) {
      console.warn("[webrtc] music-grade mic capture failed; retrying plain audio", musicErr);
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (plainErr) {
        console.warn("[webrtc] plain mic capture failed", plainErr);
      }
    }

    if (!stream?.getAudioTracks().length) {
      throw new Error("Ohiyo could not hear your microphone. Check browser mic permission, then join again.");
    }
    for (const track of stream.getAudioTracks()) track.enabled = true;
    return stream;
  }, []);

  const acquireLocalMedia = useCallback(async (wantVideo: boolean): Promise<MediaStream> => {
    const stream = await acquireMicStream();

    if (wantVideo) {
      try {
        const cam = await navigator.mediaDevices.getUserMedia({ video: true });
        const videoTrack = cam.getVideoTracks()[0] ?? null;
        if (videoTrack) stream.addTrack(videoTrack);
        hasRealCameraRef.current = !!videoTrack;
      } catch (err) {
        console.warn("[webrtc] camera capture failed; joining voice-only", err);
        stream.addTrack(blankVideoTrack());
        hasRealCameraRef.current = false;
      }
    } else {
      // Voice-only should feel like voice-only: ask for microphone, not camera.
      stream.addTrack(blankVideoTrack());
      hasRealCameraRef.current = false;
    }

    const videoTrack = stream.getVideoTracks()[0] ?? null;
    cameraTrackRef.current = videoTrack;
    if (videoTrack) videoTrack.enabled = wantVideo && hasRealCameraRef.current;
    return stream;
  }, [acquireMicStream]);

  // ── Public actions ────────────────────────────────────────────────────────
  const joinVoice = useCallback(async (cid: string, opts?: { video?: boolean }) => {
    if (channelRef.current) return;
    setCallState("joining");
    try {
      // Fetch fresh ICE servers (short-lived TURN creds) before any peer is made.
      // Race a 5s timeout so a hung request can't trap the user on "joining".
      const iceTimeout = new Promise<RTCIceServer[]>((_, reject) =>
        setTimeout(() => reject(new Error("ice-servers timeout")), 5000),
      );
      iceServersRef.current = await Promise.race([cbRef.current.getIceServers(), iceTimeout]).catch((e) => {
        console.warn("[webrtc] ICE fetch failed/slow — STUN fallback", e);
        return FALLBACK_ICE;
      });
      const wantVideo = opts?.video ?? false;
      const stream = await acquireLocalMedia(wantVideo);
      localStreamRef.current = stream;
      setLocalStream(stream);
      channelRef.current = cid;
      setChannelId(cid);
      const startVideo = wantVideo && hasRealCameraRef.current;
      setSelf({ muted: false, video: startVideo, screen: false });
      cbRef.current.sendJoin(cid, false, startVideo);
      setCallState("connected");
    } catch (err) {
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      channelRef.current = null;
      setLocalStream(null);
      setChannelId(null);
      setCallState("idle");
      throw err;
    }
  }, [acquireLocalMedia]);

  const hangUp = useCallback(() => {
    const cid = channelRef.current;
    if (cid) cbRef.current.sendLeave(cid);
    for (const id of [...pcsRef.current.keys()]) closePeer(id);
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenAudioSendersRef.current.clear();
    localStreamRef.current = null;
    screenStreamRef.current = null;
    cameraTrackRef.current = null;
    channelRef.current = null;
    setLocalStream(null);
    setRemoteStreams(new Map());
    setParticipants(new Map());
    setSelf({ muted: false, video: false, screen: false });
    setChannelId(null);
    setCallState("idle");
  }, [closePeer]);

  const pushMeta = useCallback((next: { muted: boolean; video: boolean; screen: boolean }) => {
    const cid = channelRef.current;
    if (cid) cbRef.current.sendMeta(cid, next.muted, next.video, next.screen);
  }, []);

  const toggleAudio = useCallback(() => {
    setSelf((prev) => {
      const muted = !prev.muted;
      const track = localStreamRef.current?.getAudioTracks()[0];
      if (track) track.enabled = !muted;
      const next = { ...prev, muted };
      pushMeta(next);
      return next;
    });
  }, [pushMeta]);

  const toggleVideo = useCallback(async () => {
    const cur = selfRef.current;

    // Voice-only joins intentionally ask for mic only. If the user later turns
    // camera on, acquire the camera then and swap it onto the existing video
    // senders — no dead button, no rejoin required.
    if (!cur.video && !hasRealCameraRef.current) {
      try {
        const cam = await navigator.mediaDevices.getUserMedia({ video: true });
        const track = cam.getVideoTracks()[0] ?? null;
        if (!track) return;
        cameraTrackRef.current?.stop();
        cameraTrackRef.current = track;
        hasRealCameraRef.current = true;
        const audioTracks = localStreamRef.current?.getAudioTracks() ?? [];
        const nextStream = new MediaStream([...audioTracks, track]);
        localStreamRef.current = nextStream;
        if (!cur.screen) {
          for (const { pc } of pcsRef.current.values()) {
            const sender = pc.getSenders().find((s) => s.track?.kind === "video");
            if (sender) void sender.replaceTrack(track).catch(() => {});
          }
          setLocalStream(nextStream);
        }
      } catch (err) {
        console.warn("[webrtc] camera enable failed", err);
        return;
      }
    }

    const latest = selfRef.current;
    const video = !latest.video;
    const track = cameraTrackRef.current;
    if (track && !latest.screen) track.enabled = video;
    const next = { ...latest, video };
    setSelf(next);
    pushMeta(next);
  }, [pushMeta]);

  /** Start/stop screen share. Video swap is renegotiation-free (replaceTrack);
   *  optional system audio adds a track and renegotiates each peer. */
  const toggleScreenShare = useCallback(async (opts?: { presetId?: ScreenSharePresetId; wantAudio?: boolean }) => {
    const cur = selfRef.current;
    if (cur.screen) {
      // ── Stop sharing ──
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;
      screenShareBitrateRef.current = null;
      const cam = cameraTrackRef.current;
      for (const { pc } of pcsRef.current.values()) {
        const sender = pc.getSenders().find((s) => s.track?.kind === "video");
        if (sender && cam) await sender.replaceTrack(cam).catch(() => {});
      }
      // Remove screen-audio senders + renegotiate to drop the m-line.
      let hadAudio = false;
      for (const [id, sender] of screenAudioSendersRef.current) {
        const entry = pcsRef.current.get(id);
        try { entry?.pc.removeTrack(sender); hadAudio = true; } catch { /* ignore */ }
      }
      screenAudioSendersRef.current.clear();
      if (cam) cam.enabled = cur.video;
      setLocalStream(localStreamRef.current);
      const next = { ...cur, screen: false };
      setSelf(next);
      pushMeta(next);
      if (hadAudio) for (const id of pcsRef.current.keys()) await renegotiate(id);
      return;
    }

    // ── Start sharing ──
    const preset = getPreset(opts?.presetId ?? DEFAULT_PRESET_ID);
    let captured;
    try {
      captured = await captureDisplay(preset, opts?.wantAudio ?? false);
    } catch {
      return; // user cancelled the native picker
    }
    const { stream: display, videoTrack: screenTrack, audioTrack } = captured;
    screenStreamRef.current = display;
    screenShareBitrateRef.current = preset.maxBitrate;

    // Swap the screen video onto every sender (no renegotiation) + apply bitrate.
    for (const { pc } of pcsRef.current.values()) {
      const sender = pc.getSenders().find((s) => s.track?.kind === "video");
      if (sender) {
        await sender.replaceTrack(screenTrack).catch(() => {});
        await applySenderBitrate(sender, preset.maxBitrate);
      }
    }

    // Optional system/tab audio → its own sender per peer; needs renegotiation.
    if (audioTrack) {
      for (const [id, { pc }] of pcsRef.current) {
        try {
          const sender = pc.addTrack(audioTrack, display);
          screenAudioSendersRef.current.set(id, sender);
        } catch { /* ignore */ }
      }
      for (const id of pcsRef.current.keys()) await renegotiate(id);
    }

    // Local self-tile previews the screen.
    const preview = new MediaStream([screenTrack, ...(localStreamRef.current?.getAudioTracks() ?? [])]);
    setLocalStream(preview);
    screenTrack.onended = () => { void toggleScreenShare(); };
    const next = { ...selfRef.current, screen: true };
    setSelf(next);
    pushMeta(next);
  }, [pushMeta, renegotiate]);

  // Tear down media + peer connections if the component unmounts mid-call.
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only teardown must read the LATEST refs (streams get reassigned), not mount-time snapshots
      for (const { pc } of pcsRef.current.values()) {
        try { pc.close(); } catch { /* ignore */ }
      }
      pcsRef.current.clear();
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const participantList = [...participants.values()];

  // Live per-peer connection quality (RTT / loss / jitter → signal bars).
  const getPeers = useCallback(() => {
    const m = new Map<string, RTCPeerConnection>();
    for (const [id, e] of pcsRef.current) m.set(id, e.pc);
    return m;
  }, []);
  const quality = usePeerQuality(getPeers, participantList.map((p) => p.user_id));

  return {
    callState,
    channelId,
    localStream,
    remoteStreams,
    participants: participantList,
    self,
    quality,
    joinVoice,
    hangUp,
    toggleAudio,
    toggleVideo,
    toggleScreenShare,
    // gateway-driven
    onRoster,
    onPeerSignal,
    onVoiceState,
    // Voice E2EE key gossip — a no-op in mesh mode (P2P media isn't relayed through an
    // SFU, so there's nothing to frame-encrypt); only the LiveKit engine implements it.
    onVoiceKey: (_channelId: string, _fromUserId: string, _envelope: string) => {},
  };
}

export type UseWebRTCReturn = ReturnType<typeof useWebRTC>;
export type { PeerQuality };
