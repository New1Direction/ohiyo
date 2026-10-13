import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { CallOverlay } from "../../src/components/CallOverlay";
export { act };

type Self = { muted: boolean; deafened: boolean; video?: boolean; screen?: boolean; listenOnly?: boolean };
type Peer = { user_id: string; name: string; muted: boolean; deafened?: boolean };

/** The call overlay over a fake call engine, recording which controls were pressed. */
export function mountCallOverlay(
  element: HTMLElement,
  { self, peers, pushToTalk }: { self: Self; peers: Peer[]; pushToTalk?: { keyLabel: string; transmitting: boolean } | null },
) {
  const calls: string[] = [];
  const record = (name: string) => () => {
    calls.push(name);
  };
  const webrtc = {
    callState: "connected",
    channelId: "v1",
    localStream: null,
    remoteStreams: new Map(),
    participants: peers.map((p) => ({
      user_id: p.user_id,
      user: { id: p.user_id, username: p.user_id, display_name: p.name, avatar_url: null },
      muted: p.muted,
      deafened: p.deafened ?? false,
      video: false,
      screen: false,
      listenOnly: false,
    })),
    self: { video: false, screen: false, listenOnly: false, ...self },
    quality: {},
    joinVoice: async () => {},
    hangUp: record("hangUp"),
    toggleAudio: async () => {
      calls.push("toggleAudio");
    },
    toggleDeafen: record("toggleDeafen"),
    toggleVideo: async () => {},
    toggleScreenShare: async () => {},
    setTransmitGate: () => {},
    onRoster: () => {},
    onPeerSignal: async () => {},
    onVoiceState: () => {},
    onVoiceKey: () => {},
  };
  const root = createRoot(element);
  act(() =>
    root.render(
      <CallOverlay
        webrtc={webrtc as never}
        currentUser={{ id: "me", username: "me", display_name: "Me", avatar_url: null } as never}
        channelName="General"
        pushToTalk={pushToTalk ?? null}
      />,
    ),
  );
  return {
    calls,
    unmount: () => act(() => root.unmount()),
  };
}
