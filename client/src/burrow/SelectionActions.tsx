import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import "./selection.css";

function markdown(node: Node): string {
  if (node.nodeType === 3) return (node.textContent ?? "").replace(/([\\`*_[\]<>])/g, "\\$1");
  if (node.nodeType !== 1 && node.nodeType !== 11) return "";
  const el = node as Element;
  const content = () => Array.from(node.childNodes, markdown).join("");
  const tag = el.tagName?.toLowerCase();
  if (["script", "style", "button", "input", "textarea", "select"].includes(tag)) return "";
  if (tag === "pre") {
    const text = node.textContent ?? "";
    const fence = "`".repeat(Math.max(3, ...Array.from(text.matchAll(/`+/g), m => m[0].length + 1)));
    return `\n\n${fence}\n${text}\n${fence}\n\n`;
  }
  if (tag === "code") {
    const text = node.textContent ?? "";
    const fence = "`".repeat(Math.max(1, ...Array.from(text.matchAll(/`+/g), m => m[0].length + 1)));
    return `${fence} ${text} ${fence}`;
  }
  if (tag === "strong" || tag === "b") return `**${content()}**`;
  if (tag === "em" || tag === "i") return `*${content()}*`;
  if (tag === "a") {
    const href = el.getAttribute("href") ?? "";
    return /^https?:\/\//i.test(href) ? `[${content()}](${href.replace(/\(/g, "%28").replace(/\)/g, "%29")})` : content();
  }
  if (tag === "br") return "\n";
  if (tag && /^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${content()}\n\n`;
  if (tag === "blockquote") return `\n\n${content().trim().split("\n").map(line => `> ${line}`).join("\n")}\n\n`;
  if (tag === "li") return `\n${el.parentElement?.tagName === "OL" ? `${Array.from(el.parentElement.children).indexOf(el) + Number(el.parentElement.getAttribute("start") || 1)}.` : "-"} ${content().trim()}`;
  if (tag === "table") {
    const rows = Array.from(el.querySelectorAll("tr"), row => Array.from(row.children, cell => markdown(cell).trim().replace(/\n+/g, " ").replace(/\|/g, "\\|")));
    if (!rows.length) return "";
    const width = Math.max(...rows.map(row => row.length));
    const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => row[i] ?? "").join(" | ")} |`;
    return `\n\n${[line(rows[0]), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n")}\n\n`;
  }
  const text = content();
  return ["p", "div", "section", "ul", "ol"].includes(tag) ? `\n\n${text}\n\n` : text;
}

type Pick = { text: string; markdown: string; x: number; y: number; below: boolean };

// Local selection only. Actions never call the worker or save a preference.
export default function SelectionActions({ root, onQuote, onRemember }: {
  root: RefObject<HTMLElement | null>; onQuote?: (text: string) => void; onRemember?: (text: string) => void;
}) {
  const [pick, setPick] = useState<Pick | null>(null);
  const [notice, setNotice] = useState("");
  const toolbar = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const copying = useRef(false);
  useEffect(() => {
    const read = () => {
      if (dragging.current || toolbar.current?.contains(document.activeElement)) return;
      if (document.activeElement?.matches("input, textarea, select, [contenteditable]")
        || document.activeElement?.closest("[contenteditable]")) { setPick(null); return; }
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount !== 1) { setPick(null); return; }
      const range = selection.getRangeAt(0);
      const element = range.startContainer.nodeType === 1 ? range.startContainer as Element : range.startContainer.parentElement;
      const area = element?.closest("[data-selection-content]");
      if (!area || !root.current?.contains(area) || !area.contains(range.endContainer)
        || element?.closest("input, textarea, button, select, [contenteditable]")) { setPick(null); return; }
      const fragment = range.cloneContents();
      if (fragment.querySelector("input, textarea, button, select, [contenteditable]")) { setPick(null); return; }
      const text = selection.toString().trim();
      if (!text || text.length > 20_000) { setPick(null); return; }
      // cloneContents omits ancestors shared by both endpoints. Retain their
      // formatting when a highlight stays inside a link, bold text or a table.
      let formatted: Node = fragment;
      let ancestor = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer as Element : range.commonAncestorContainer.parentElement;
      const tableSelection = /^(TABLE|THEAD|TBODY|TR)$/.test(ancestor?.tagName ?? "");
      for (; ancestor && area.contains(ancestor); ancestor = ancestor.parentElement) {
        if (/^(STRONG|B|EM|I|A|CODE|PRE|BLOCKQUOTE|LI|UL|OL|H[1-6])$/.test(ancestor.tagName)
          || (tableSelection && /^(TABLE|THEAD|TBODY|TR)$/.test(ancestor.tagName))) {
          const wrapper = ancestor.cloneNode(false); wrapper.appendChild(formatted); formatted = wrapper;
        }
        if (ancestor === area) break;
      }
      const rect = range.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > window.innerHeight) { setPick(null); return; }
      const below = rect.top < 70;
      setNotice("");
      setPick({ text, markdown: markdown(formatted).trim().replace(/\n{3,}/g, "\n\n"),
        x: Math.max(8, Math.min(rect.left, window.innerWidth - 328)),
        y: below ? Math.min(rect.bottom + 8, window.innerHeight - 64) : rect.top - 8, below });
    };
    const down = (event: PointerEvent) => {
      if (toolbar.current?.contains(event.target as Node)) return;
      dragging.current = true; setPick(null); setNotice("");
    };
    const up = () => { dragging.current = false; read(); };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { setPick(null); setNotice(""); } else if (event.key !== "Tab") read(); };
    const hide = () => { setPick(null); };
    document.addEventListener("selectionchange", read);
    document.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);
    document.addEventListener("keyup", key);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("selectionchange", read); document.removeEventListener("pointerdown", down);
      document.removeEventListener("pointerup", up); document.removeEventListener("keyup", key);
      document.removeEventListener("scroll", hide, true); window.removeEventListener("resize", hide);
    };
  }, [root]);
  async function copy(asMarkdown: boolean) {
    if (!pick || copying.current) return;
    copying.current = true;
    try { await navigator.clipboard.writeText(asMarkdown ? pick.markdown : pick.text); setNotice(asMarkdown ? "Markdown copied" : "Copied"); }
    catch { setNotice("Couldn’t copy. Your selection is still here; use your browser’s Copy command."); }
    finally { copying.current = false; }
  }
  return createPortal(<>{pick && <div ref={toolbar} className="burrow-selection" style={{ left: pick.x, top: pick.y, transform: pick.below ? undefined : "translateY(-100%)" }}
    role="group" aria-label="Selected text actions" onPointerDown={e => e.preventDefault()}>
    <button type="button" onClick={() => void copy(false)} title="Copy selected text">Copy</button>
    <button type="button" onClick={() => void copy(true)} title="Copy selected text with Markdown formatting">Markdown</button>
    {onQuote && <button type="button" onClick={() => { onQuote(pick.text); setPick(null); }}>Quote</button>}
    {onRemember && <button type="button" disabled={pick.text.length > 1200} title={pick.text.length > 1200 ? "Select up to 1,200 characters to remember" : "Review before saving a choice"} onClick={() => { onRemember(pick.text); setPick(null); }}>Remember</button>}
    <button type="button" aria-label="Dismiss selected text actions" onClick={() => setPick(null)}>×</button>
  </div>}{notice && <div className="burrow-selection-notice" role="status">{notice}</div>}</>, document.body);
}
