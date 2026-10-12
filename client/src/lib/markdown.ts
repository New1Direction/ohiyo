// Message formatting (stub: replaced by the parser in the next commit).

export type TimestampStyle = "t" | "T" | "d" | "D" | "f" | "F" | "R";

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold" | "italic" | "underline" | "strike"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "spoiler"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[]; destinationHost: string | null }
  | { kind: "url"; href: string; text: string }
  | { kind: "emoji"; name: string }
  | { kind: "time"; unix: number; style: TimestampStyle }
  | { kind: "br" };

export type ListItem = { children: Inline[]; sublist: ListBlock | null };
export type ListBlock = { kind: "list"; ordered: boolean; start: number; items: ListItem[] };
export type Block =
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "heading"; level: 1 | 2 | 3; children: Inline[] }
  | { kind: "subtext"; children: Inline[] }
  | { kind: "quote"; children: Block[] }
  | ListBlock
  | { kind: "code"; lang: string | null; text: string };

export function parseInline(src: string): Inline[] {
  return src ? [{ kind: "text", text: src }] : [];
}

export function parseMarkdown(src: string): Block[] {
  return [{ kind: "paragraph", children: parseInline(src) }];
}

export function inlinePlainText(nodes: readonly Inline[]): string {
  return nodes.map((n) => (n.kind === "text" ? n.text : "")).join("");
}

export function formatTimestamp(
  _unix: number,
  _style: TimestampStyle,
  _opts: { now: number; locale?: string; timeZone?: string }
): string {
  return "";
}
