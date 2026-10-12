// Placeholder with today's behaviour, replaced by the fix: the gradient sits in the
// `background` shorthand next to a `backgroundImage` longhand.
export function defaultAvatarStops(id: string): [string, string] {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return [`oklch(70% 0.13 ${h})`, `oklch(60% 0.15 ${(h + 28) % 360})`];
}

export function avatarStyle(id: string, url: string | null | undefined): Record<string, string | undefined> {
  const [from, to] = defaultAvatarStops(id);
  return {
    background: `linear-gradient(135deg, ${from}, ${to})`,
    backgroundImage: url ? `url(${url})` : undefined,
    backgroundSize: "cover",
    backgroundPosition: "center",
  };
}
