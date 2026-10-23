import { useId, useState } from "react";
import "./requestJourney.css";

export default function RequestJourney() {
  const id = useId();
  const [step, setStep] = useState(0);
  const [cached, setCached] = useState(false);
  const steps = [
    { label: "Browser", action: "Read the address", heading: "A name, not a destination yet", text: "You enter an HTTPS address. The browser separates the site's name from the page path. Before opening a new connection, it needs an IP address for that name.", detail: "The name identifies the site. The path identifies the resource you want." },
    cached
      ? { label: "DNS", action: "Reuse a fresh address", heading: "The address is already here", text: "In this scenario the browser has a still-valid DNS answer. It reuses that IP address without asking a DNS resolver again.", detail: "This cache stores an address, not the page. The server is still contacted in the next steps." }
      : { label: "DNS", action: "Ask for an address", heading: "Turn the name into an IP address", text: "There is no usable local DNS answer. The device asks a DNS resolver, which returns an IP address. The resolver may use its own cache or consult other DNS servers.", detail: "DNS finds the destination. It does not send the web page back." },
    { label: "Connection", action: "Connect securely", heading: "Make a secure connection", text: "The browser connects to the destination and establishes HTTPS encryption, checking the site's certificate. We assume a new connection in both scenarios.", detail: "Real browsers can reuse connections. The exact handshake depends on the HTTP version; those details are outside this model." },
    { label: "Server", action: "Request → response", heading: "Ask for the page", text: "The browser sends an HTTP request for the page path. The server returns an HTTP response: a status, headers, and usually a body such as HTML.", detail: "DNS caching does not skip this request. This example has no page cache or service worker." },
    { label: "Browser", action: "Read and render", heading: "Bytes become a page", text: "The browser parses the HTML and builds the page. It may request styles, scripts, images, and fonts, then lay out and paint what you see.", detail: "A page can start appearing before every resource finishes. This is an illustrated sequence, not a live network trace." },
  ];
  const current = steps[step];
  return <section className="request-journey" aria-label="Interactive web request journey">
    <fieldset className="request-journey-scenario">
      <legend>Change one condition</legend>
      {[false, true].map(value => <label key={String(value)}>
        <input type="radio" name={`${id}-cache`} checked={cached === value} onChange={() => setCached(value)} />
        <span>DNS cache {value ? "fresh" : "empty"}</span>
      </label>)}
    </fieldset>
    <div className="request-journey-workspace">
    <ol className="request-journey-route" aria-label="Request steps">
      {steps.map((item, index) => <li key={index}>
        <button type="button" aria-pressed={step === index} aria-controls={`${id}-detail`} onClick={() => setStep(index)}>
          <span className="request-journey-number" aria-hidden="true">{index + 1}</span>
          <span><strong>{item.label}</strong><small>{item.action}</small></span>
          <span className="request-journey-arrow" aria-hidden="true">{step === index ? "↗" : "↓"}</span>
        </button>
      </li>)}
    </ol>
    <div className="request-journey-detail" id={`${id}-detail`} aria-live="polite" aria-atomic="true">
      <p className="gen-kicker">STEP {step + 1} OF {steps.length} · {cached ? "FRESH DNS CACHE" : "EMPTY DNS CACHE"}</p>
      <h3>{current.heading}</h3><p>{current.text}</p>
      <p className="request-journey-note">{current.detail}</p>
    </div>
    </div>
    <div className="request-journey-controls">
      <button type="button" className="burrow-link" disabled={step === 0} onClick={() => setStep(step - 1)}>← Previous</button>
      <button type="button" className="gen-button" onClick={() => setStep((step + 1) % steps.length)}>{step === steps.length - 1 ? "Start again" : "Next step →"}</button>
    </div>
    <p className="request-journey-scope">A simplified HTTPS visit with no page cache. Nothing is sent over the network. Select a step to explore it.</p>
  </section>;
}
