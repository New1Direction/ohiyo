import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { drawField, type DotField } from "./backdropFields";
import type { ShaderMount } from "@paper-design/shaders";

const looks = [
  ["ember", "Ember", "#f49b87"],
  ["neural", "Neural bloom", "#bca3f5"],
  ["terrain", "Rainbow terrain", "#edb872"],
  ["mandala", "Dot mandala", "#dd9acb"],
  ["orbit", "Particle orbit", "#8ad5bf"],
  ["ascii", "ASCII orbit", "#91b8f0"],
  ["paper-swirl", "Paper · dither swirl", "#b6a1fa"],
  ["paper-mesh", "Paper · dotted aurora", "#83d7c9"],
  ["off", "Quiet · no backdrop", "#aaa29b"],
] as const;
type Look = typeof looks[number][0];
const storageKey = "burrow:backdrop";
const tones = [
  ["original", "Original", "conic-gradient(#eaa48e, #a4caba, #aaa0dc, #eaa48e)", "none"],
  ["peach", "Peach", "#e8ad8e", "grayscale(1) sepia(1) saturate(2) hue-rotate(335deg)"],
  ["mint", "Mint", "#9fd6bd", "grayscale(1) sepia(1) saturate(2) hue-rotate(95deg)"],
  ["blue", "Blue", "#9ebfe8", "grayscale(1) sepia(1) saturate(2) hue-rotate(165deg)"],
  ["lilac", "Lilac", "#baa7e5", "grayscale(1) sepia(1) saturate(2) hue-rotate(210deg)"],
  ["rose", "Rose", "#df9ebc", "grayscale(1) sepia(1) saturate(2) hue-rotate(280deg)"],
] as const;
type Tone = typeof tones[number][0];
function savedTone(): Tone {
  try { return tones.find(([id]) => id === localStorage.getItem("burrow:backdrop-tone"))?.[0] ?? "original"; }
  catch { return "original"; }
}
function savedLook(): Look {
  try { const stored = localStorage.getItem(storageKey); return looks.find(([id]) => id === stored)?.[0] ?? "ember"; }
  catch { return "ember"; }
}

export default function Backdrop({ paused, resting = false }: { paused: boolean; resting?: boolean }) {
  const [look, setLook] = useState(savedLook);
  const [tone, setTone] = useState(savedTone);
  const requestedTone = useRef(tone);
  const pulse = useRef<HTMLDivElement>(null);
  const pulseAnimation = useRef<Animation | null>(null);
  const tint = tones.find(([id]) => id === tone)!;
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [hidden, setHidden] = useState(() => document.hidden);
  const [fallback, setFallback] = useState(false);
  const layer = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const paper = useRef<HTMLDivElement>(null);
  const shader = useRef<ShaderMount | null>(null);
  const clock = useRef(8);
  const running = !paused && !resting && !reduced && !hidden;
  const run = useRef(running);
  const wake = useRef<(() => void) | null>(null);
  const index = looks.findIndex(([id]) => id === look);
  const [, name, color] = looks[index];

  useLayoutEffect(() => {
    const root = layer.current?.closest<HTMLElement>(".burrow");
    if (root) root.dataset.tone = tone;
    return () => { if (root) delete root.dataset.tone; };
  }, [tone]);
  useEffect(() => () => pulseAnimation.current?.cancel(), []);
  useEffect(() => { if (reduced || paused || hidden) pulseAnimation.current?.cancel(); }, [reduced, paused, hidden]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const motion = () => setReduced(media.matches);
    const visibility = () => setHidden(document.hidden);
    media.addEventListener("change", motion);
    document.addEventListener("visibilitychange", visibility);
    return () => { media.removeEventListener("change", motion); document.removeEventListener("visibilitychange", visibility); };
  }, []);
  useEffect(() => {
    run.current = running;
    shader.current?.setSpeed(running ? .15 : 0);
    wake.current?.();
  }, [running]);

  useEffect(() => {
    const host = layer.current;
    const surface = canvas.current;
    if (!host || !surface || look === "off" || look === "ember") return;
    let disposed = false;
    let frame = 0;
    let last = 0;
    let width = 0;
    let height = 0;
    let useCanvas = !look.startsWith("paper-");
    const ctx = surface.getContext("2d");
    const pointer = { x: 0, y: 0 };
    const target = { x: 0, y: 0 };
    const field = (useCanvas ? look : "orbit") as DotField;
    function paint() { if (ctx && useCanvas) drawField(ctx, field, width, height, clock.current, pointer); }
    function tick(now: number) {
      frame = 0;
      if (disposed || !run.current || !useCanvas) { last = 0; return; }
      if (!last || now - last >= 1000 / 24) {
        clock.current += last ? Math.min((now - last) / 1000, .1) : 0;
        last = now;
        pointer.x += (target.x - pointer.x) * .08;
        pointer.y += (target.y - pointer.y) * .08;
        paint();
      }
      frame = requestAnimationFrame(tick);
    }
    function resume() {
      if (!run.current) { cancelAnimationFrame(frame); frame = 0; last = 0; }
      else if (!frame && useCanvas) frame = requestAnimationFrame(tick);
    }
    wake.current = resume;
    function resize() {
      const rect = host!.getBoundingClientRect();
      const scale = Math.min(1, 1200 / Math.max(1, rect.width), 900 / Math.max(1, rect.height));
      width = Math.max(1, rect.width * scale); height = Math.max(1, rect.height * scale);
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      surface!.width = Math.round(width * dpr); surface!.height = Math.round(height * dpr);
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint();
    }
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const pane = host.closest("main");
    function move(event: PointerEvent) {
      if (!run.current || event.pointerType === "touch") return;
      const rect = host!.getBoundingClientRect();
      target.x = (event.clientX - rect.left) / Math.max(1, rect.width) * 2 - 1;
      target.y = (event.clientY - rect.top) / Math.max(1, rect.height) * 2 - 1;
    }
    function leave() { target.x = 0; target.y = 0; }
    pane?.addEventListener("pointermove", move, { passive: true });
    pane?.addEventListener("pointerleave", leave);
    resize(); resume();
    const paperHost = paper.current;
    let shaderCanvas: HTMLCanvasElement | undefined;
    function showFallback() {
      if (disposed) return;
      shader.current?.dispose(); shader.current = null;
      paperHost?.replaceChildren();
      useCanvas = true; setFallback(true); paint(); resume();
    }
    if (!useCanvas && paperHost) {
      void import("./paperBackdrop").then(({ mountPaperBackdrop }) => {
        if (disposed) return;
        try {
          shader.current = mountPaperBackdrop(paperHost, look === "paper-mesh");
          shaderCanvas = shader.current.canvasElement;
          shaderCanvas.addEventListener("webglcontextlost", showFallback);
          shader.current.setSpeed(run.current ? .15 : 0);
        } catch { showFallback(); }
      }).catch(showFallback);
    }
    return () => {
      disposed = true; cancelAnimationFrame(frame); observer.disconnect(); wake.current = null;
      pane?.removeEventListener("pointermove", move); pane?.removeEventListener("pointerleave", leave);
      shaderCanvas?.removeEventListener("webglcontextlost", showFallback);
      shader.current?.dispose(); shader.current = null;
      paperHost?.replaceChildren();
    };
  }, [look]);

  function next() {
    const value = looks[(index + 1) % looks.length][0];
    setLook(value); setFallback(false);
    try { localStorage.setItem(storageKey, value); } catch { /* Still usable when storage is blocked. */ }
  }
  function nextTone(event: MouseEvent<HTMLButtonElement>) {
    const value = tones[(tones.findIndex(([id]) => id === requestedTone.current) + 1) % tones.length][0];
    requestedTone.current = value;
    setTone(value);
    try { localStorage.setItem("burrow:backdrop-tone", value); } catch { /* Still usable when storage is blocked. */ }
    pulseAnimation.current?.cancel();
    if (reduced || paused || hidden || !pulse.current?.animate) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    Object.assign(pulse.current.style, { width: `${radius * 2}px`, height: `${radius * 2}px`, left: `${x - radius}px`, top: `${y - radius}px` });
    pulse.current.style.setProperty("--pulse-colour", value === "original" ? "#f49b87" : tones.find(([id]) => id === value)![2]);
    pulseAnimation.current = pulse.current.animate([
      { transform: "scale(0)", opacity: 0 },
      { opacity: .3, offset: .18 },
      { transform: "scale(1)", opacity: 0 },
    ], { duration: 700, easing: "cubic-bezier(.2,.7,.2,1)" });
  }
  const description = `${name}${fallback ? " · dots fallback" : ""}. Tap for ${looks[(index + 1) % looks.length][1]}.`;
  const toneDescription = `${tint[1]}. Tap for ${tones[(tones.findIndex(([id]) => id === tone) + 1) % tones.length][1]}.`;
  return <>
    {createPortal(<div ref={pulse} className="burrow-colour-pulse" aria-hidden="true" />, document.body)}
    <div ref={layer} className={`burrow-ambience${running ? "" : " backdrop-still"}`} data-backdrop={look} data-tone={tone} style={{ filter: look === "off" ? "none" : tint[3] }} aria-hidden="true">
      {look === "ember" && <><pre className="burrow-ascii north">{"    +\n .     :\n    /    .\n :    +"}</pre><pre className="burrow-ascii east">{" .    /\n   :\n +   .\n    :   +"}</pre><pre className="burrow-ascii south">{"    .   +\n :    /\n   +    ."}</pre></>}
      {look !== "ember" && look !== "off" && <><canvas ref={canvas} className="backdrop-field" /><div ref={paper} className={`backdrop-paper${look === "paper-mesh" ? " dotted" : ""}`} /></>}
    </div>
    <div className="burrow-backdrop-switch">
      <button type="button" className="burrow-backdrop-dot" aria-label={`Change background. ${description}`} onClick={next}><span style={{ background: color }} aria-hidden="true" /></button>
      <span className="burrow-backdrop-tip" aria-hidden="true">{description}</span>
      <span className="sr-only" role="status">Background: {name}{fallback ? ". WebGL unavailable; showing dots instead." : ""}</span>
    </div>
    <div className="burrow-backdrop-switch">
      <button type="button" className="burrow-backdrop-dot burrow-tone-dot" aria-label={`Change colour. ${toneDescription}`} onClick={nextTone}><span style={{ background: tint[2] }} aria-hidden="true" /></button>
      <span className="burrow-backdrop-tip" aria-hidden="true">{toneDescription}</span>
      <span className="sr-only" role="status">Colour: {tint[1]}</span>
    </div>
  </>;
}
