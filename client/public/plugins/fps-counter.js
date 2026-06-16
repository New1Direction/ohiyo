export default {
  id: "fps-counter",
  name: "FPS Counter",
  description: "Shows a real-time FPS overlay to prove Ohiyo runs at 60fps",
  version: "1.0.0",
  css: `
    #kk-fps {
      position: fixed;
      bottom: 12px;
      right: 12px;
      background: rgba(0, 0, 0, 0.72);
      color: #00ff88;
      font: bold 12px/1 monospace;
      padding: 5px 9px;
      border-radius: 6px;
      z-index: 9999;
      pointer-events: none;
      letter-spacing: 0.04em;
      border: 1px solid rgba(0,255,136,0.3);
    }
    #kk-fps.good { color: #00ff88; border-color: rgba(0,255,136,0.3); }
    #kk-fps.warn { color: #ffcc00; border-color: rgba(255,204,0,0.3); }
    #kk-fps.bad  { color: #ff4444; border-color: rgba(255,68,68,0.3); }
  `,
  onLoad() {
    const el = document.createElement("div");
    el.id = "kk-fps";
    el.textContent = "FPS: --";
    document.body.appendChild(el);

    let frames = 0;
    let last = performance.now();

    const tick = () => {
      frames++;
      const now = performance.now();
      if (now - last >= 500) {
        const fps = Math.round((frames * 1000) / (now - last));
        el.textContent = `FPS: ${fps}`;
        el.className = fps >= 55 ? "good" : fps >= 30 ? "warn" : "bad";
        frames = 0;
        last = now;
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  },
  onUnload() {
    cancelAnimationFrame(this._raf);
    document.getElementById("kk-fps")?.remove();
  },
};
