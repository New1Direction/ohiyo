// Entry bundled by test/voiceSignalGate.test.ts: runs the mesh call hook once through
// react-dom/server and hands back what it returns. After that render, state setters are
// no-ops and refs keep working, so the gateway handlers can be driven directly.
import { renderToStaticMarkup } from "react-dom/server";
import { useWebRTC, type UseWebRTCReturn, type WebRTCCallbacks } from "../../src/hooks/useWebRTC";

export function runWebRTC(cb: WebRTCCallbacks): UseWebRTCReturn {
  let api: UseWebRTCReturn | null = null;
  function Probe() {
    api = useWebRTC(cb);
    return null;
  }
  renderToStaticMarkup(<Probe />);
  if (!api) throw new Error("useWebRTC did not run");
  return api;
}
