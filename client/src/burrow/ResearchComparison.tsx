import type { ResearchComparison, ResearchFact } from "../api";
import type { ReactNode } from "react";
import { MessageContent } from "../components/MessageMarkdown";

function ResearchDocument({ text }: { text: string }) {
  const lines = text.split('\n'), parts: ReactNode[] = [];
  const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(s => s.trim());
  let plain: string[] = [], fence = "";
  const flush = () => { if (plain.length) { parts.push(<div key={`text-${parts.length}`}><MessageContent content={plain.join('\n')} serverEmojis={[]} /></div>); plain = []; } };
  for (let i = 0; i < lines.length; i++) {
    const marker = lines[i].match(/^\s*(`{3,}|~{3,})/);
    if (marker) fence = fence ? (marker[1][0] === fence[0] && marker[1].length >= fence.length ? "" : fence) : marker[1];
    const headings = cells(lines[i]), separator = cells(lines[i + 1] ?? "");
    if (fence || headings.length < 2 || headings.length > 20 || separator.length !== headings.length || !separator.every(s => /^:?-{3,}:?$/.test(s))) { plain.push(lines[i]); continue; }
    const rows: string[][] = []; let end = i + 2;
    while (end < lines.length && lines[end].includes('|') && lines[end].trim()) { rows.push(cells(lines[end])); end++; }
    if (!rows.length || rows.length > 100 || rows.some(r => r.length !== headings.length)) { plain.push(lines[i]); continue; }
    flush();
    // Wide research tables keep the identifying columns in view; every other
    // cell remains available with its original heading below, not discarded.
    const visible = headings.length > 5 ? 4 : headings.length;
    parts.push(<section className="burrow-saved-table" key={`table-${i}`}>
      <div className="burrow-comparison-table"><table><caption>Comparison at a glance</caption><thead><tr>{headings.slice(0, visible).map((h, j) => <th scope="col" key={j}><MessageContent content={h} serverEmojis={[]} /></th>)}</tr></thead><tbody>{rows.map((r, j) => <tr key={j}>{r.slice(0, visible).map((cell, k) => k === 0 ? <th scope="row" key={k}><MessageContent content={cell} serverEmojis={[]} /></th> : <td key={k}><MessageContent content={cell} serverEmojis={[]} /></td>)}</tr>)}</tbody></table></div>
      {visible < headings.length && <details className="burrow-comparison-sources"><summary>Full details & sources ({rows.length} options)</summary>{rows.map((r, j) => <div key={j}><h3><MessageContent content={r[0]} serverEmojis={[]} /></h3><dl>{r.slice(visible).map((cell, k) => <div key={k}><dt>{headings[k + visible]}</dt><dd><MessageContent content={cell} serverEmojis={[]} /></dd></div>)}</dl></div>)}</details>}
    </section>);
    i = end - 1;
  }
  flush();
  return <div className="burrow-document burrow-research-document">{parts}</div>;
}

function Fact({ fact }: { fact: ResearchFact }) {
  return <details className="burrow-fact"><summary>{fact.label}: <strong>{fact.value}</strong></summary><blockquote>{fact.quote}</blockquote><p className="burrow-small"><a href={fact.source_url} target="_blank" rel="noreferrer noopener">Open source ↗</a> · Captured {fact.captured_at}</p></details>;
}

// Older saved documents are not structured evidence. Improve their presentation
// without reinterpreting amounts, converting currencies, or claiming validation.
export function SavedResearchText({ text }: { text: string }) {
  const blocks = text.split(/\n\s*\n/).filter(s => s.trim());
  const rows = blocks.map(block => block.split('|').map(s => s.trim()));
  const isComparison = rows.length > 1 && rows.every(row => row.length >= 4 && row.length <= 7
    && /^Annual offer:/i.test(row[1]) && /^12 [×x]/.test(row[2]) && /^https:\/\//.test(row[3]));
  if (!isComparison) return <ResearchDocument text={text} />;
  return <div className="burrow-comparison burrow-legacy-comparison">
    <p className="burrow-small">Earlier saved research · Original wording, not rechecked.</p>
    <div className="burrow-comparison-table"><table><caption>Plan comparison</caption><thead><tr><th scope="col">Option</th><th scope="col">Annual offer</th><th scope="col">12 months at monthly rate</th></tr></thead>
      <tbody>{rows.map((row, i) => <tr key={i}><th scope="row">{row[0]}</th><td>{row[1].replace(/^Annual offer:\s*/i, '')}</td><td>{row[2].replace(/^12 [×x] monthly estimate:\s*/i, '')}</td></tr>)}</tbody></table></div>
    <p className="burrow-comparison-note">Monthly-rate illustrations are not advertised annual plans. Different currencies are not directly comparable. Eligibility and additional charges remain unverified.</p>
    <details className="burrow-comparison-sources"><summary>Sources & capture details ({rows.length})</summary>{rows.map((row, i) => {
      let url: URL; try { url = new URL(row[3]); } catch { return <p key={i}>{row.slice(3).join(' · ')}</p>; }
      return <div key={i}><strong>{row[0]}</strong><p><a href={url.href} target="_blank" rel="noreferrer noopener">{url.hostname} ↗</a></p><p className="burrow-small">{row[4]}</p><details><summary>Saved reference</summary><code>{row.slice(5).join(' · ')}</code></details></div>;
    })}</details>
    <details className="burrow-comparison-original"><summary>Original saved text</summary><pre>{text}</pre></details>
  </div>;
}

export default function Comparison({ value }: { value: ResearchComparison }) {
  return <div className="burrow-comparison"><h3>{value.title}</h3>{!!value.requirements.length && <details><summary>Requirements used</summary><ul>{value.requirements.map((r, i) => <li key={i}>{r}</li>)}</ul></details>}
    <div className="burrow-comparison-table"><table><caption className="sr-only">Options at a glance</caption><thead><tr><th scope="col">Option</th><th scope="col">Price & billing</th><th scope="col">12-month illustration</th></tr></thead><tbody>{value.options.map((o, i) => <tr key={i}><th scope="row">{o.name}</th><td>{o.price ? <><strong>{o.price.currency.value} {o.price.amount.value}</strong><small>{o.price.billing.value}</small></> : <span>Unknown</span>}</td><td>{o.annualized_monthly ? `${o.annualized_monthly.currency} ${o.annualized_monthly.amount}` : 'Not calculated'}</td></tr>)}</tbody></table></div>
    <p className="burrow-comparison-note">12-month illustrations use the monthly rate—not an advertised annual offer. Currencies are not converted. Eligibility and the full cost may still be unknown.</p>
    {value.options.map((o, i) => <section key={i}><h3>{o.name}</h3>{!!o.unknowns?.length && <p className="burrow-comparison-unknown">Still unknown: {o.unknowns.join(" · ")}</p>}<details><summary>Details & supporting quotes</summary>{o.attributes.map((f, j) => <Fact key={j} fact={f} />)}{o.price ? <>{(["amount", "currency", "billing", "shipping", "tax"] as const).map(k => o.price![k] ? <Fact key={k} fact={o.price![k]!} /> : <p className="burrow-small" key={k}>{k === "shipping" ? "Shipping" : "Tax"}: unknown</p>)}</> : <p className="burrow-small">Price, shipping and tax: unknown</p>}</details>{o.sources?.map(s => <details key={s.evidence_id}><summary>Source · {new URL(s.url).hostname}</summary><p className="burrow-small"><a href={s.url} target="_blank" rel="noreferrer noopener">Open original page ↗</a><br />Captured {s.captured_at}</p><ul className="burrow-small">{s.limitations.map((l, j) => <li key={j}>{l}</li>)}</ul></details>)}</section>)}
    <p className="burrow-small">Supporting quotes match saved pages, not independent verification. Open a source to check its wording and capture time.</p>
  </div>;
}
