// Placeholder: swipe navigation on phones (see test/swipeNav.test.ts).
export type Panel = "none" | "nav" | "members";
export type SwipeOptions = {
  viewportWidth: number;
  navWidth: number;
  membersWidth: number;
  canOpenMembers: boolean;
  edgeGuard: number;
  lockSlop?: number;
  openFraction?: number;
  flingVelocity?: number;
};
export type Swipe = { open: Panel };
export function startSwipe(_open: Panel, _x: number, _y: number, _t: number, _o: SwipeOptions): Swipe | null {
  return null;
}
export function moveSwipe(s: Swipe, _x: number, _y: number, _t: number): Swipe {
  return s;
}
export function swipeProgress(_s: Swipe): { panel: "nav" | "members"; openness: number } | null {
  return null;
}
export function endSwipe(s: Swipe, _x: number, _y: number, _t: number): Panel {
  return s.open;
}
