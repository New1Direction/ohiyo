// What a pasted or opened Ohiyo link points at. (Stub: the parser lands with the feature.)
export type SharedLink = { kind: "invite"; code: string } | { kind: "dm"; token: string };

export function parseSharedLink(_raw: string, _base?: string): SharedLink | null {
  return null;
}
