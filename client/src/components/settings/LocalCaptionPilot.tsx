import { useEffect, useRef, useState } from "react";
import { CAPTION_DOWNLOAD_BYTES, LocalCaptionSession, captionUnsupported, type CaptionState } from "../../lib/localCaptions";

type Props = { disabledReason?: string; claimMicrophone: () => boolean; releaseMicrophone: () => void };
const ms = (value: number | null) => value === null ? "Not measured" : `${Math.round(value)} ms`;

export function LocalCaptionPilot(props: Props) {
  const propsRef = useRef(props); propsRef.current = props;
  const session = useRef<LocalCaptionSession | null>(null);
  const [state, setState] = useState<CaptionState | null>(null);
  const unsupported = captionUnsupported();
  useEffect(() => {
    const current = new LocalCaptionSession(setState, () => propsRef.current.claimMicrophone(), () => propsRef.current.releaseMicrophone());
    session.current = current;
    setState(current.state);
    const pagehide = () => current.clearModels();
    window.addEventListener("pagehide", pagehide);
    return () => { window.removeEventListener("pagehide", pagehide); current.dispose(); session.current = null; };
  }, []);
  useEffect(() => { session.current?.setBlocked(!!props.disabledReason); }, [props.disabledReason]);
  const status = state?.status ?? "idle";
  const downloading = status === "downloading";
  const capturing = status === "starting" || status === "listening";
  const ready = !!session.current?.hasModels;
  const reason = props.disabledReason || unsupported;

  return (
    <section className="kc-voice-panel" aria-labelledby="kc-local-caption-title" data-testid="local-caption-pilot">
      <h3 id="kc-local-caption-title" className="kc-voice-panel__title">Local captions · experimental</h3>
      <p className="kc-voice-note">
        English · Moonshine Tiny Streaming · your microphone only, not call audio.
        Text stays in this tab’s memory. No cloud fallback, audio upload or saved caption history.
        Captions can be wrong; don’t rely on them for critical information.
      </p>
      <p className="kc-voice-note" id="kc-caption-download-note">
        Download about {(CAPTION_DOWNLOAD_BYTES / 1_000_000).toFixed(1)} MB from this Ohiyo host, only when you choose Download.
        Model: 51.4 MB from Moonshine’s English quantized_26_07_30 release. Runtime: @moonshine-ai/moonshine-wasm 0.1.5, about 13.4 MB.
        Both are MIT; runtime third-party notices apply. Downloads are SHA-256 checked and kept only in RAM.
      </p>
      <details className="kc-voice-note">
        <summary>Sources &amp; licenses</summary>
        <p>Original model source: download.moonshine.ai. Runtime source: npm. Hashes were derived locally over HTTPS, not independently signed by upstream.</p>
        <a href="/local-captions/0.1.5-tiny-en-260730/NOTICES.txt" target="_blank" rel="noreferrer">Runtime and model license notices (on this host)</a>
      </details>
      {reason && <p className="kc-voice-note" id="kc-caption-disabled">{reason}</p>}
      <div className="kc-voice-meter-row" style={{ flexWrap: "wrap" }}>
        <button type="button" className="kc-voice-button" disabled={!!reason || downloading || capturing || ready}
          aria-describedby="kc-caption-download-note" onClick={() => void session.current?.download()}>
          {downloading ? "Downloading…" : ready ? "Model ready in memory" : "Download model & runtime"}
        </button>
        <button type="button" className="kc-voice-button" disabled={!!reason || !ready || downloading || capturing}
          onClick={() => void session.current?.start()}>Start preview</button>
        {(downloading || capturing) && <button type="button" className="kc-voice-button" onClick={() => session.current?.stop()}>
          {downloading ? "Cancel download" : "Stop & clear text"}
        </button>}
        <button type="button" className="kc-voice-button kc-voice-button--quiet" disabled={!ready && !downloading && !capturing && !state?.error}
          onClick={() => session.current?.clearModels()}>Clear models &amp; text</button>
      </div>
      <p className="kc-voice-note" role="status">
        {downloading ? `${((state?.bytes ?? 0) / 1_000_000).toFixed(1)} / ${(CAPTION_DOWNLOAD_BYTES / 1_000_000).toFixed(1)} MB verified`
          : status === "starting" ? "Preparing local worker, then requesting your microphone…"
          : status === "listening" ? "Listening locally. Stops after 3 minutes; Stop, leaving Voice settings or closing Settings clears the text."
          : ready ? "Verified model is in memory. Start is a separate microphone action."
          : "Caption capture off. No model downloaded."}
      </p>
      {state?.error && <p className="kc-voice-note kc-voice-note--error" role="alert">{state.error}</p>}
      <div role="log" aria-label="Local caption preview" aria-live="polite" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 180, overflowY: "auto", marginBlock: 12, padding: 12, border: "1px solid var(--bg-hover)", borderRadius: 8, background: "var(--bg-base)", lineHeight: 1.5 }}>
        {state?.text || (status === "listening" ? "Speak a short English sentence…" : "Your temporary captions will appear here.")}
      </div>
      <details className="kc-voice-note">
        <summary>Session measurements &amp; evaluation limits</summary>
        <p>Download + checks: {ms(state?.downloadMs ?? null)} · Worker/model startup: {ms(state?.loadMs ?? null)} · First text from mic start (includes silence): {ms(state?.firstTextMs ?? null)}</p>
        <p>Worker feed + inference: {state?.audioSeconds ? `${Math.round(state.inferenceMs)} ms / ${state.audioSeconds.toFixed(1)} s audio` : "Not measured"} · Dropped audio: {(state?.droppedSeconds ?? 0).toFixed(2)} s</p>
        <p>Memory and battery telemetry: unsupported. Accuracy: not evaluated. Evaluate desktop/mobile performance and English word error rate before expanding to received audio. No transcript export or automatic benchmark upload.</p>
      </details>
    </section>
  );
}
