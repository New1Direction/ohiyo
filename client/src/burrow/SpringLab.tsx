import { useId, useState } from "react";
import "./springLab.css";

const GRAVITY = 9.8;
const ZERO_Y = 192;
const PIXELS_PER_CM = 4.5;

// Original SVG geometry, informed by Anatomy’s pinned geometry kit offline.
// No upstream implementation or runtime dependency is bundled. The bench uses
// a 30°-elevation isometric view; the ruler and spring share a vertical scale.
function Block({ x, y, w, d, h }: { x: number; y: number; w: number; d: number; h: number }) {
  const a = `${x},${y - h}`;
  const b = `${x + w},${y + w / 2 - h}`;
  const c = `${x + w - d},${y + (w + d) / 2 - h}`;
  const e = `${x - d},${y + d / 2 - h}`;
  return <g className="spring-lab-solid">
    <polygon className="spring-lab-side" points={`${e} ${c} ${x + w - d},${y + (w + d) / 2} ${x - d},${y + d / 2}`} />
    <polygon className="spring-lab-end" points={`${b} ${c} ${x + w - d},${y + (w + d) / 2} ${x + w},${y + w / 2}`} />
    <polygon className="spring-lab-top" points={`${a} ${b} ${c} ${e}`} />
  </g>;
}

export default function SpringLab() {
  const id = useId();
  const [mass, setMass] = useState(1);
  const [stiffness, setStiffness] = useState(100);
  const force = mass * GRAVITY;
  const extensionCm = force / stiffness * 100;
  const bottom = ZERO_Y + extensionCm * PIXELS_PER_CM;
  const massText = mass.toFixed(2).replace(/0$/, "");
  const forceText = Number(force.toFixed(2)).toString();
  const extensionText = Number(extensionCm.toFixed(2)).toString();
  const coil = Array.from({ length: 193 }, (_, i) => {
    const fraction = i / 192;
    const angle = fraction * Math.PI * 16;
    const x = 174 + Math.sin(angle) * 17;
    const y = 105 + fraction * (bottom - 109) + Math.cos(angle) * 4;
    return `${i ? "L" : "M"}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");

  return <section className="spring-lab" aria-labelledby={`${id}-heading`}>
    <header className="spring-lab-header">
      <div><p className="spring-lab-eyebrow">BENCH 01 · HOOKE’S LAW</p><h3 id={`${id}-heading`}>How far will it stretch?</h3></div>
      <button type="button" className="spring-lab-reset" onClick={() => { setMass(1); setStiffness(100); }}>Reset</button>
    </header>
    <p className="spring-lab-prediction"><strong>Predict, then try.</strong> Keep the mass at 1 kg. If you double the stiffness from 100 to 200 N/m, what happens to the extension?</p>
    <div className="spring-lab-workspace">
      <figure className="spring-lab-figure">
        <div className="spring-lab-plate-heading"><span>STATIC EQUILIBRIUM</span><span>g = 9.8 m/s²</span></div>
        <svg viewBox="30 20 300 485" role="img" aria-labelledby={`${id}-drawing-title ${id}-drawing-desc`}>
          <title id={`${id}-drawing-title`}>Isometric spring test bench</title>
          <desc id={`${id}-drawing-desc`}>A spring hangs from a bolted stand above a mass hanger. With {massText} kilograms and a stiffness of {stiffness} newtons per metre, the downward weight and upward spring force are each {forceText} newtons. The pointer marks {extensionText} centimetres of extension on a fixed ruler, measured below the unloaded spring end.</desc>
          <ellipse cx="175" cy="471" rx="127" ry="27" className="spring-lab-shadow" />
          {/* Four levelling feet support the thick, bevel-edged bedplate. */}
          {[[87, 411], [155, 382], [267, 440], [198, 474]].map(([x, y]) => <g key={`${x}-${y}`}>
            <Block x={x} y={y + 10} w={12} d={12} h={9} />
            <path d={`M${x - 9} ${y + 13}h18`} className="spring-lab-detail" />
          </g>)}
          <Block x={137} y={365} w={151} d={89} h={13} />
          <path d="M137 357L280 428.5L199 469L56 397.5Z" className="spring-lab-detail" />
          {[[137, 363], [270, 429], [198, 465], [65, 399]].map(([x, y]) => <g key={`${x}-${y}`} className="spring-lab-fastener">
            <ellipse cx={x} cy={y} rx="3.5" ry="1.8" /><path d={`M${x - 2} ${y}h4`} />
          </g>)}
          {/* Upright, socket, cross-arm, bracing and clamping screws. */}
          <Block x={105} y={391} w={27} d={25} h={9} />
          <Block x={108} y={380} w={12} d={12} h={326} />
          <Block x={108} y={71} w={12} d={12} h={20} />
          <Block x={107} y={66} w={79} d={12} h={11} />
          <path d="M109 110L145 82L139 79L109 99Z" className="spring-lab-brace" />
          <Block x={108} y={382} w={16} d={16} h={13} />
          {[68, 374].map(y => <g key={y} className="spring-lab-fastener">
            <circle cx="99" cy={y} r="5" /><path d={`M96 ${y}h6`} />
          </g>)}
          <path d="M174 98V109" className="spring-lab-wire" />
          <ellipse cx="174" cy="98" rx="5" ry="3" className="spring-lab-collar" />
          {/* A fixed scale is bolted to its own upright, never to the mass. */}
          <Block x={249} y={429} w={19} d={18} h={7} />
          <Block x={249} y={421} w={7} d={7} h={259} />
          <path d="M238 172L244 169V390L238 393Z" className="spring-lab-brace" />
          <rect x="238" y="172" width="51" height="221" rx="4" className="spring-lab-ruler" />
          <text x="266" y="183" className="spring-lab-unit">cm</text>
          {[178, 386].map(y => <circle key={y} cx="244" cy={y} r="1.8" className="spring-lab-screw" />)}
          {Array.from({ length: 41 }, (_, cm) => <g key={cm}>
            <path d={`M238 ${ZERO_Y + cm * PIXELS_PER_CM}h${cm % 10 === 0 ? 14 : cm % 5 === 0 ? 10 : 5}`} className="spring-lab-tick" />
            {cm % 10 === 0 && <text x="260" y={ZERO_Y + cm * PIXELS_PER_CM + 5} className="spring-lab-scale-number">{cm}</text>}
          </g>)}
          <path d={`M148 ${ZERO_Y}H238`} className="spring-lab-zero" />
          <path d={coil} className="spring-lab-coil-shadow" />
          <path d={coil} className="spring-lab-coil" />
          <g transform={`translate(0 ${bottom})`}>
            <path d="M174 0V33M174 0H232" className="spring-lab-wire" />
            <path d="M232 -4L239 0L232 4Z" className="spring-lab-pointer" />
            <ellipse cx="174" cy="34" rx="26" ry="9" className="spring-lab-pan" />
            <path d="M148 31V35C148 47 200 47 200 35V31" className="spring-lab-pan" />
            <ellipse cx="174" cy="31" rx="26" ry="9" className="spring-lab-pan" />
            {Array.from({ length: Math.round(mass / 0.25) }, (_, i) => <g key={i} transform={`translate(0 ${-i * 3})`}>
              <path d="M153 26V29C153 39 195 39 195 29V26" className="spring-lab-weight-side" />
              <ellipse cx="174" cy="26" rx="21" ry="7" className="spring-lab-weight-top" />
              <ellipse cx="174" cy="26" rx="3" ry="1.5" className="spring-lab-screw" />
            </g>)}
            <path d={`M174 0V${26 - Math.round(mass / 0.25) * 3}`} className="spring-lab-wire" />
          </g>
        </svg>
        <figcaption><span className="spring-lab-key" aria-hidden="true" />Dashed line: unloaded end. Pointer: extra stretch, not total spring length. Each disc adds 0.25 kg.</figcaption>
      </figure>
      <div className="spring-lab-console">
        <div className="spring-lab-control">
          <label htmlFor={`${id}-mass`}>Hanging mass <span>{massText} kg</span></label>
          <input id={`${id}-mass`} type="range" min="0" max="2" step="0.25" value={mass} aria-valuetext={`${massText} kilograms`} onChange={event => setMass(Number(event.target.value))} />
          <div className="spring-lab-range-ends" aria-hidden="true"><span>0 kg</span><span>2 kg</span></div>
        </div>
        <div className="spring-lab-control">
          <label htmlFor={`${id}-stiffness`}>Spring stiffness <span>{stiffness} N/m</span></label>
          <input id={`${id}-stiffness`} type="range" min="50" max="200" step="25" value={stiffness} aria-valuetext={`${stiffness} newtons per metre`} onChange={event => setStiffness(Number(event.target.value))} />
          <div className="spring-lab-range-ends" aria-hidden="true"><span>Softer · 50</span><span>200 · Stiffer</span></div>
        </div>
        <dl className="spring-lab-readouts" aria-live="polite" aria-atomic="true">
          <div><dt>Weight · mg</dt><dd>{forceText} <span>N</span></dd></div>
          <div><dt>Extension · x</dt><dd>{extensionText} <span>cm</span></dd></div>
        </dl>
        <div className="spring-lab-equation"><strong>kx = mg</strong><p>The upward spring force balances the downward weight.</p><p>x = mg ÷ k = {extensionText} cm</p></div>
      </div>
    </div>
    <details className="spring-lab-explanation">
      <summary>Made your prediction? Compare the reasoning</summary>
      <p>At 1 kg, the weight stays 9.8 N. A 100 N/m spring stretches 9.8 cm; a 200 N/m spring needs only 4.9 cm to balance that same weight. Doubling stiffness halves extension, not force. Reset, then keep stiffness fixed and double the mass. Can you explain the result?</p>
    </details>
    <p className="spring-lab-limits"><strong>An ideal model.</strong> Massless spring and hanger; constant gravity; linear springs with no elastic limit. Real springs can permanently deform. The bench shows settled positions instantly, not oscillation or settling time. Geometry is illustrative; extension and ruler share one fixed scale. Readouts round to 0.01.</p>
  </section>;
}
