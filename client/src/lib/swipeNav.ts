// Swiping between the chat, the space/channel drawer (from the left) and the member list
// (from the right) on a phone. Pure: the hook in hooks/useSwipeNav.ts feeds it touch points
// and moves the panels; this decides when a touch is a swipe, how open the panel is while the
// finger is down, and what is open when it lifts.

/** What is open over the chat. */
export type Panel = "none" | "nav" | "members";

export type SwipeOptions = {
  viewportWidth: number;
  /** Widths of the drawer and the member panel, in px: how far a finger moves to open one. */
  navWidth: number;
  membersWidth: number;
  /** False where there's no member list to show (the DM list). */
  canOpenMembers: boolean;
  /** Touches starting this close to either edge are left to the browser (Safari's back and
   *  forward swipes); 0 turns it off. */
  edgeGuard: number;
  /** How far the finger moves before we decide sideways or up/down. */
  lockSlop?: number;
  /** Share of the panel's width past which a slow swipe settles it the other way. */
  openFraction?: number;
  /** px/ms: a flick at least this fast settles it in the direction of the flick. */
  flingVelocity?: number;
};

type Axis = "undecided" | "sideways" | "vertical";

export type Swipe = {
  open: Panel;
  o: Required<SwipeOptions>;
  x0: number;
  y0: number;
  x: number;
  t: number;
  /** The previous sample, for the speed at release. */
  px: number;
  pt: number;
  axis: Axis;
};

const DEFAULTS = { lockSlop: 10, openFraction: 0.4, flingVelocity: 0.45 };

/** A touch begins. Null when it is left to the browser (an edge swipe). */
export function startSwipe(open: Panel, x: number, y: number, t: number, options: SwipeOptions): Swipe | null {
  const o = { ...DEFAULTS, ...options };
  if (open === "none" && o.edgeGuard > 0 && (x < o.edgeGuard || x > o.viewportWidth - o.edgeGuard)) return null;
  return { open, o, x0: x, y0: y, x, t, px: x, pt: t, axis: "undecided" };
}

/** The finger moves. Once it has gone `lockSlop` px, the swipe is sideways or up/down for good. */
export function moveSwipe(s: Swipe | null, x: number, y: number, t: number): Swipe {
  if (!s) return s as unknown as Swipe;
  let axis = s.axis;
  if (axis === "undecided") {
    const dx = Math.abs(x - s.x0);
    const dy = Math.abs(y - s.y0);
    if (Math.max(dx, dy) >= s.o.lockSlop) axis = dx > dy ? "sideways" : "vertical";
  }
  return { ...s, axis, px: s.x, pt: s.t, x, t };
}

/** Which panel the finger is moving and how open it is (0 shut, 1 open), or null while the
 *  swipe isn't one that moves a panel. */
export function swipeProgress(s: Swipe | null): { panel: "nav" | "members"; openness: number } | null {
  if (!s || s.axis !== "sideways") return null;
  const dx = s.x - s.x0;
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  switch (s.open) {
    case "none":
      if (dx > 0) return { panel: "nav", openness: clamp(dx / s.o.navWidth) };
      if (dx < 0 && s.o.canOpenMembers) return { panel: "members", openness: clamp(-dx / s.o.membersWidth) };
      return null;
    case "nav":
      return dx < 0 ? { panel: "nav", openness: clamp(1 + dx / s.o.navWidth) } : null;
    case "members":
      return dx > 0 ? { panel: "members", openness: clamp(1 - dx / s.o.membersWidth) } : null;
  }
}

/** The finger lifts: what is open now. A quick flick goes the way it was flicked; otherwise
 *  the panel settles open once it is past `openFraction` of the way. */
export function endSwipe(s: Swipe | null, x: number, y: number, t: number): Panel {
  if (!s) return "none";
  // A lift at the same moment as the last move adds nothing; keep that move's speed.
  const last = t > s.t || x !== s.x ? moveSwipe(s, x, y, t) : s;
  const moved = swipeProgress(last);
  if (!moved) return s.open;
  const dt = last.t - last.pt;
  const velocity = dt > 0 ? (last.x - last.px) / dt : 0;
  // Positive velocity is towards the right: it opens the drawer and shuts the member list.
  const opening = moved.panel === "nav" ? velocity : -velocity;
  const wasOpen = s.open === moved.panel;
  let open: boolean;
  if (Math.abs(velocity) >= last.o.flingVelocity) open = opening > 0;
  else open = wasOpen ? 1 - moved.openness < last.o.openFraction : moved.openness >= last.o.openFraction;
  if (open) return moved.panel;
  return wasOpen ? "none" : s.open;
}
