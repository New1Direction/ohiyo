import { useEffect, useRef, useState } from "react";
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
function savedLook(): Look {
  try { const stored = localStorage.getItem(storageKey); return looks.find(([id]) => id === stored)?.[0] ?? "ember"; }
  catch { return "ember"; }
}

export default function Backdrop({ paused, resting = false }: { paused: boolean; resting?: boolean }) {
  const [look, setLook] = useState(savedLook);
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
  const description = `${name}${fallback ? " · dots fallback" : ""}. Tap for ${looks[(index + 1) % looks.length][1]}.`;
  return <>
    <div ref={layer} className={`burrow-ambience${running ? "" : " backdrop-still"}`} data-backdrop={look} aria-hidden="true">
      {look === "ember" && <><pre className="burrow-ascii north">{"    +\n .     :\n    /    .\n :    +"}</pre><pre className="burrow-ascii east">{" .    /\n   :\n +   .\n    :   +"}</pre><pre className="burrow-ascii south">{"    .   +\n :    /\n   +    ."}</pre></>}
      {look !== "ember" && look !== "off" && <><canvas ref={canvas} className="backdrop-field" /><div ref={paper} className={`backdrop-paper${look === "paper-mesh" ? " dotted" : ""}`} /></>}
    </div>
    <div className="burrow-backdrop-switch">
      <button type="button" className="burrow-backdrop-dot" aria-label={`Change background. ${description}`} onClick={next}><span style={{ background: color }} aria-hidden="true" /></button>
      <span className="burrow-backdrop-tip" aria-hidden="true">{description}</span>
      <span className="sr-only" role="status">Background: {name}{fallback ? ". WebGL unavailable; showing dots instead." : ""}</span>
    </div>
  </>;
}
