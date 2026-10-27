import { parsePage, catalog } from "./catalog";
import type { PresentationExport } from "../api";

export type PresentationSlide = { title: string; text: string; notes: string };

/** Static, semantic content only. Never inspect DOM, execute a page or fetch assets. */
export function presentationSlides(format: "document" | "creation", content: string): PresentationSlide[] {
  if (format === "document") {
    const headings = [...content.matchAll(/^#{1,3}\s+Slide\s+\d+\s*[:—–-]\s*(.+)$/gim)];
    const sections = headings.length ? [
      ...(content.slice(0, headings[0].index).trim() ? [{ title: "Introduction", text: content.slice(0, headings[0].index).trim() }] : []),
      ...headings.map((h, i) => ({ title: h[1].trim(), text: content.slice(h.index! + h[0].length, headings[i + 1]?.index).trim() })),
    ] : [{ title: "Presentation", text: content }];
    return sections.map(s => {
      const note = /^\s*(?:\*\*)?(?:Speaker notes|Notes)\s*:(?:\*\*)?\s*/im.exec(s.text);
      return { title: s.title, text: note ? s.text.slice(0, note.index).trim() : s.text, notes: note ? s.text.slice(note.index + note[0].length) : "" };
    });
  }
  const page = parsePage((JSON.parse(content) as { page: unknown }).page);
  const slides: PresentationSlide[] = [{ title: page.title, text: page.description, notes: "Static text export. Interactions and progress are not included." }];
  function walk(id: string) {
    const el = page.spec.elements[id];
    let title = page.title, text = "";
    const notes = "";
    switch (el.type) {
      case "Stack": case "Columns": case "Card": break;
      case "Heading": case "Text": text = String(el.props.text); break;
      case "Callout": text = String(el.props.text); title = String(el.props.title); break;
      case "Reveal": title = String(el.props.label); text = String(el.props.text); break;
      case "Metric": title = String(el.props.label); text = `${el.props.value}\n${el.props.detail}`; break;
      case "Table": {
        const p = catalog.data.components.Table.props.parse(el.props);
        title = "Table"; text = [p.columns.join(" | "), ...p.rows.map(row => row.cells.join(" | "))].join("\n"); break;
      }
      case "BarChart": {
        const p = catalog.data.components.BarChart.props.parse(el.props);
        title = p.title; text = p.bars.map(b => `${b.label}: ${b.value}`).join("\n"); break;
      }
      case "Checklist": {
        const p = catalog.data.components.Checklist.props.parse(el.props);
        title = p.title; text = p.items.map(i => `${i.done ? "☑" : "☐"} ${i.text}`).join("\n"); break;
      }
      case "Quiz": {
        const p = catalog.data.components.Quiz.props.parse(el.props);
        for (const q of p.questions) slides.push({ title: q.question, text: q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join("\n"), notes: `Answer: ${String.fromCharCode(65 + q.answer)}. ${q.options[q.answer]}\n${q.explanation}` });
        break;
      }
      case "Story": {
        const p = catalog.data.components.Story.props.parse(el.props);
        for (const s of p.scenes) slides.push({ title: s.heading, text: s.text, notes: `Scene: ${s.id}\n${s.choices.map(c => `${c.label} → ${c.next}`).join("\n") || "Ending"}` });
        break;
      }
      default: throw new Error("This page contains a live learning activity that cannot be faithfully exported to PowerPoint. Create a text outline first; nothing was downloaded.");
    }
    if (text) slides.push({ title, text, notes });
    for (const child of el.children ?? []) walk(child);
  }
  walk(page.spec.root);
  return slides;
}

// Bound text per slide without dropping a long line or splitting a Unicode character.
function pages(text: string): string[] {
  const chars = Array.from(text);
  const chunks: string[] = [];
  let next = "", lines = 0;
  for (const char of chars) {
    if (next.length >= 1200 || lines >= 14) { chunks.push(next); next = ""; lines = 0; }
    next += char;
    if (char === "\n") lines++;
  }
  if (next || !chunks.length) chunks.push(next);
  return chunks;
}

export async function presentationPptx(value: PresentationExport): Promise<Uint8Array> {
  const content = presentationSlides(value.format, value.content);
  const { default: PptxGenJS } = await import("pptxgenjs");
  const deck = new PptxGenJS();
  deck.layout = "LAYOUT_WIDE";
  deck.author = "Burrow"; deck.subject = `Human-reviewed school material · ${value.audience}`;
  deck.title = content[0].title;
  deck.theme = { headFontFace: "Aptos Display", bodyFontFace: "Aptos" };
  const sources = value.citations.map((c, i) => `[${i + 1}] ${c.title}\nClaim: ${c.claim}\n${c.notes?.trim() ? "Saved school notes" : c.url}\nSupporting excerpt: ${c.quote}`);
  const all = [...content, ...value.citations.map((c, i) => ({ title: `Source ${i + 1}: ${c.title}`, text: `Claim: ${c.claim}\n\n${c.quote}\n\n${c.notes?.trim() ? "Saved school notes" : c.url}`, notes: "Source checked by the person approving this material, not verified by Burrow or AI." }))];
  let number = 0;
  for (const part of all) {
    for (const [index, text] of pages(part.text).entries()) {
      const slide = deck.addSlide();
      slide.background = { color: "FAF9F6" };
      slide.addText(`${part.title}${index ? " (continued)" : ""}`, { x: 0.65, y: 0.45, w: 12, h: 1, fontSize: 28, bold: true, color: "24263B", fit: "shrink", margin: 0 });
      slide.addText(text, { x: 0.65, y: 1.65, w: 12, h: 4.8, fontSize: 22, color: "24263B", valign: "top", fit: "shrink", breakLine: false, margin: 0 });
      slide.addText(`Reviewed for ${value.audience} · Saved version ${value.version} · ${++number}`, { x: 0.65, y: 7.0, w: 12, h: 0.22, fontSize: 10, color: "616174", fit: "shrink", margin: 0 });
      slide.addNotes(`${part.notes}\n\nAudience: ${value.audience}\nSaved version: ${value.version}\n\nSources and claim mapping:\n${sources.join("\n\n")}`);
    }
  }
  return new Uint8Array(await deck.write({ outputType: "arraybuffer", compression: true }) as ArrayBuffer);
}
