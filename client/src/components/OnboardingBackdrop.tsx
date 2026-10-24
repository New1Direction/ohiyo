import { useEffect, useRef } from "react";

export type AccentPulse = { id: number; x: number; y: number };

// A colorful ramp centered on the user's accent, rather than a monochrome wash.
function palette(hex: string) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const hue = d === 0 ? 0 : 60 * (max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4);
  return Array.from({ length: 256 }, (_, i) => {
    const h = ((hue + Math.sin(i / 256 * Math.PI * 2) * 110) % 360 + 360) % 360 / 30;
    return [0, 8, 4].map(n => {
      const k = (n + h) % 12;
      return Math.round((.68 - .24 * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
    });
  });
}

/** Decorative only: never intercepts input or rerenders the form on pointer movement. */
export function OnboardingBackdrop({ accent, pulse, paused }: {
  accent: string; pulse: AccentPulse | null; paused: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scene = useRef({
    time: 0, colors: palette(accent), previous: palette(accent), accent,
    pulseId: 0, pulseAt: -10, originX: 0, originY: 0,
    x: 0, y: 0, targetX: 0, targetY: 0, tailX: 0, tailY: 0, strength: 0, target: 0,
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const root = canvas?.parentElement;
    const ctx = canvas?.getContext("2d");
    // Paint one small pixel buffer. CSS scales its intentionally pixelated art;
    // full-resolution canvas drawing otherwise competes with the form's input.
    if (!canvas || !root || !ctx) return;
    let pixels = ctx.createImageData(1, 1), step = 4;
    const state = scene.current;
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = preference.matches, visible = true, frame = 0, last = 0;
    let width = 1, height = 1;
    const bayer = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    if (state.accent !== accent || (pulse && state.pulseId !== pulse.id)) {
      state.previous = state.colors;
      state.colors = palette(accent);
      state.accent = accent;
    }
    if (pulse && state.pulseId !== pulse.id) {
      state.pulseId = pulse.id;
      state.pulseAt = reduced || paused ? -10 : state.time;
      const box = canvas.getBoundingClientRect();
      state.originX = pulse.x - box.left;
      state.originY = pulse.y - box.top;
    }
    if (reduced) state.strength = state.target = 0;

    function draw() {
      if (!ctx) return;
      const data = pixels.data;
      data.fill(0);
      const stride = pixels.width * 4, t = state.time;
      const age = (state.time - state.pulseAt) / 1.6;
      const active = age >= 0 && age < 1;
      const radius = age * Math.hypot(Math.max(state.originX, width - state.originX), Math.max(state.originY, height - state.originY));
      for (let row = 0, y = 0; y < height; row++, y += step) {
        for (let col = 0, x = 0; x < width; col++, x += step) {
          const hover = state.strength * (
            .8 * Math.exp(-((x - state.x) ** 2 + (y - state.y) ** 2) / 18000) +
            .35 * Math.exp(-((x - state.tailX) ** 2 + (y - state.tailY) ** 2) / 28000));
          const u = x / width * 5, v = y / height * 4;
          const warp = Math.sin(v * 1.8 + t * .45) + .5 * Math.cos(u * 2 - t * .3) + hover * 1.4;
          const f = (Math.sin(u * 2 + warp + t * .25) + Math.cos(v * 2.4 + Math.sin(u - t * .35)) + 2) / 4;
          if (f * .8 + .15 <= (bayer[(row % 4) * 4 + col % 4] + .5) / 16) continue;
          const distance = Math.hypot(x - state.originX, y - state.originY);
          const edge = active && Math.abs(distance - radius) < 9;
          const colors = active && distance > radius ? state.previous : state.colors;
          const index = Math.floor((f * .8 + x / width * .25 + t * .035 + hover * .38) * 256) % 256;
          const color = colors[index];
          // A feathered clearing lets text float in the scene without dark cards
          // or a hard-edged vertical strip. The colorful edges keep moving.
          const clearing = Math.exp(-(((x - width / 2) / Math.min(430, width * .48)) ** 4));
          const alpha = Math.round(255 * Math.min(1, .6 + f * .4 + hover * .2) * (.08 + .62 * (1 - clearing)));
          const start = row * 4 * stride + col * 16;
          for (let dy = 0; dy < 3; dy++) for (let dx = 0; dx < 3; dx++) {
            const p = start + dy * stride + dx * 4;
            data[p] = edge ? 242 : color[0]; data[p + 1] = edge ? 244 : color[1];
            data[p + 2] = edge ? 245 : color[2]; data[p + 3] = alpha;
          }
        }
      }
      ctx.putImageData(pixels, 0, 0);
    }
    function running() { return !paused && !reduced && visible && !document.hidden; }
    function tick(now: number) {
      frame = 0;
      if (!running()) return;
      if (now - last >= 32) {
        const dt = Math.min(.08, (now - last) / 1000);
        state.time += dt;
        state.x += (state.targetX - state.x) * (1 - Math.exp(-dt * 12));
        state.y += (state.targetY - state.y) * (1 - Math.exp(-dt * 12));
        state.tailX += (state.x - state.tailX) * (1 - Math.exp(-dt * 4));
        state.tailY += (state.y - state.tailY) * (1 - Math.exp(-dt * 4));
        state.strength += (state.target - state.strength) * (1 - Math.exp(-dt * 6));
        last = now;
        draw();
      }
      frame = requestAnimationFrame(tick);
    }
    function sync() {
      cancelAnimationFrame(frame);
      frame = 0;
      if (running()) { last = performance.now(); frame = requestAnimationFrame(tick); }
    }
    function resize() {
      if (!canvas || !ctx) return;
      const box = canvas.getBoundingClientRect();
      // Hidden or detached canvases have no drawable area during screen changes.
      if (box.width === 0 || box.height === 0) return;
      width = box.width; height = box.height;
      step = Math.max(4, Math.ceil(width / 180), Math.ceil(height / 120));
      canvas.width = Math.ceil(width / step) * 4; canvas.height = Math.ceil(height / step) * 4;
      pixels = ctx.createImageData(canvas.width, canvas.height);
      draw();
    }
    function move(e: PointerEvent) {
      if (e.pointerType !== "mouse" || reduced || paused || !canvas) return;
      const box = canvas.getBoundingClientRect();
      state.targetX = e.clientX - box.left; state.targetY = e.clientY - box.top;
      if (state.strength < .01) {
        state.x = state.tailX = state.targetX; state.y = state.tailY = state.targetY;
      }
      state.target = 1;
    }
    function leave() { state.target = 0; }
    function change(e: MediaQueryListEvent) {
      reduced = e.matches;
      state.pulseAt = -10; state.strength = state.target = 0;
      draw(); sync();
    }
    root.addEventListener("pointermove", move);
    root.addEventListener("pointerleave", leave);
    preference.addEventListener("change", change);
    document.addEventListener("visibilitychange", sync);
    const resizeObserver = new ResizeObserver(resize);
    const visibilityObserver = new IntersectionObserver(entries => { visible = entries[0].isIntersecting; sync(); });
    resizeObserver.observe(canvas); visibilityObserver.observe(canvas);
    resize(); sync();
    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect(); visibilityObserver.disconnect();
      root.removeEventListener("pointermove", move); root.removeEventListener("pointerleave", leave);
      preference.removeEventListener("change", change);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [accent, pulse, paused]);

  return <canvas ref={canvasRef} className="ohiyo-onboarding-dither" aria-hidden="true" />;
}
