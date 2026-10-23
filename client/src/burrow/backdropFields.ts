// Original decorative sketches; these do not represent model activity or task data.
export type DotField = "neural" | "terrain" | "mandala" | "orbit" | "ascii";
const tau = Math.PI * 2;
const palette = Array.from({ length: 72 }, (_, i) => `hsl(${i * 5} 72% 68%)`);

export function drawField(ctx: CanvasRenderingContext2D, field: DotField, width: number, height: number, time: number, pointer: { x: number; y: number }) {
  ctx.clearRect(0, 0, width, height);
  const unit = Math.min(width, height);
  const cx = width * .5 + pointer.x * 22;
  const cy = height * .43 + pointer.y * 18;
  function dot(x: number, y: number, color: number, radius = 1.2) {
    ctx.fillStyle = palette[((Math.floor(color) % 72) + 72) % 72];
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, tau);
    ctx.fill();
  }

  if (field === "neural") {
    function branch(x: number, y: number, angle: number, length: number, depth: number, seed: number) {
      const bend = Math.sin(time * .25 + seed) * .12;
      const ex = x + Math.cos(angle + bend) * length;
      const ey = y + Math.sin(angle + bend) * length;
      const color = 34 + seed * 7 + depth * 3;
      for (let step = 0; step < 18; step++) {
        const u = step / 18;
        const pulse = .7 + .6 * Math.sin(u * tau - time + seed);
        dot(x + (ex - x) * u, y + (ey - y) * u, color, pulse);
      }
      dot(ex, ey, color, depth === 0 ? 1.4 : 2.5);
      if (depth > 0) {
        branch(ex, ey, angle - .55 + bend, length * .69, depth - 1, seed + 1.3);
        branch(ex, ey, angle + .6 + bend, length * .72, depth - 1, seed + 2.1);
      }
    }
    for (let i = 0; i < 6; i++) {
      const a = i * tau / 6 + .25;
      branch(cx + Math.cos(a) * unit * .12, cy + Math.sin(a) * unit * .12, a, unit * .15, 4, i * 2);
    }
  } else if (field === "terrain") {
    for (let row = 0; row < 36; row++) {
      for (let col = 0; col < 86; col++) {
        const x = col / 85 * (width + 80) - 40;
        const wave = Math.sin(col * .075 + row * .14 + time * .16) * Math.cos(row * .1 - time * .12);
        const y = height * .12 + row * height / 44 + wave * unit * .13;
        dot(x + pointer.x * wave * 14, y + pointer.y * 10, col * .58 + row * .28 + time, .8 + row / 45);
      }
    }
  } else if (field === "mandala") {
    for (let ring = 0; ring < 22; ring++) {
      const count = 48 + ring * 6;
      for (let point = 0; point < count; point++) {
        const a = point / count * tau + time * .025;
        const petal = Math.sin(a * 8 + time * .12) * Math.sin(ring * .23) * unit * .045;
        const r = unit * (.035 + ring * .018) + petal;
        dot(cx + Math.cos(a) * r, cy + Math.sin(a) * r, ring * 2.4 + Math.sin(a * 8) * 6, 1.1);
      }
    }
  } else if (field === "orbit") {
    for (let ring = 0; ring < 23; ring++) {
      for (let point = 0; point < 120; point++) {
        const a = point / 120 * tau + time * (.025 + ring * .0015);
        const r = unit * (.12 + ring * .018);
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r * .48;
        const tilt = -.38 + pointer.x * .12;
        dot(cx + x * Math.cos(tilt) - y * Math.sin(tilt), cy + x * Math.sin(tilt) + y * Math.cos(tilt), ring * 2.2 + point * .12, 1 + Math.sin(a) * .35);
      }
    }
  } else {
    ctx.font = "11px monospace";
    const glyphs = ".:+=*01";
    for (let y = 8; y < height; y += 17) {
      for (let x = 8; x < width; x += 13) {
        const dx = (x - cx) / unit;
        const dy = (y - cy) / unit;
        const r = Math.hypot(dx, dy * 1.7);
        const value = Math.sin(r * 37 - time * .65 + Math.atan2(dy, dx) * 3);
        if (value < .2 || r > .75) continue;
        ctx.fillStyle = palette[(Math.floor(r * 65 + time) + 30) % 72];
        ctx.fillText(glyphs[Math.min(6, Math.floor(value * 7))], x, y);
      }
    }
  }
}
