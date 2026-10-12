// The circle behind someone's avatar. With a picture, the picture; without one, a gradient
// in a colour of their own (stable per id) under the white Ohiyo mark.
//
// Longhands only. A `background` shorthand next to a `backgroundImage` longhand that is
// sometimes undefined is a trap: React writes the undefined longhand as an empty
// background-image, which erases the gradient the shorthand set, and the circle comes out
// transparent (invisible on light themes).

/** The two gradient stops for someone's default avatar. Dark enough that the white mark
 *  on them reads at 3:1 or better on every hue (test/avatarStyle.test.ts checks it). */
export function defaultAvatarStops(id: string): [string, string] {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return [`oklch(58% 0.13 ${h})`, `oklch(50% 0.15 ${(h + 28) % 360})`];
}

/** Inline style for an avatar circle: the picture when there is one, else the person's
 *  gradient, always over a solid colour. */
export function avatarStyle(
  id: string,
  url: string | null | undefined
): { backgroundColor: string; backgroundImage: string; backgroundSize: string; backgroundPosition: string } {
  const [from, to] = defaultAvatarStops(id);
  return {
    backgroundColor: to,
    backgroundImage: url ? `url(${url})` : `linear-gradient(135deg, ${from}, ${to})`,
    backgroundSize: "cover",
    backgroundPosition: "center",
  };
}
