import { useEffect, useRef } from "react";
import { TOUCH_ACTIONS_QUERY } from "../lib/messageLayout";
import { endSwipe, moveSwipe, startSwipe, swipeProgress, type Panel, type Swipe } from "../lib/swipeNav";

// Swipe navigation on a phone: right for the drawer (spaces and channels), left for the member
// list. The rules live in lib/swipeNav.ts; this listens to touches and moves the panels.
//
// The drawer follows the finger both ways. The member panel follows the finger when it is swiped
// shut, and slides in once a swipe left is far or fast enough: it is a dialog, and opening it
// mid-swipe would move focus into it before you've decided.

const PHONE_QUERY = "(max-width: 768px)";
/** Touches this close to either edge are the browser's or the phone's own back and forward
 *  swipes (Safari, Android gesture navigation); we leave them alone. */
const EDGE_GUARD = 20;
/** Touches that start in these keep their own sideways behaviour. */
const OWN_GESTURES = 'textarea, input, select, pre, [contenteditable="true"], [data-no-swipe], .kc-call-overlay';

function scrollsSideways(el: Element | null): boolean {
  for (let node = el; node && node !== document.body; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 1) {
      const overflow = getComputedStyle(node).overflowX;
      if (overflow === "auto" || overflow === "scroll") return true;
    }
  }
  return false;
}

function reducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

type Options = {
  open: Panel;
  canOpenMembers: boolean;
  onChange: (panel: Panel) => void;
};

export function useSwipeNav({ open, canOpenMembers, onChange }: Options): void {
  const latest = useRef({ open, canOpenMembers, onChange });
  latest.current = { open, canOpenMembers, onChange };

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    let swipe: Swipe | null = null;
    let moved: HTMLElement | null = null;

    const panelEl = (panel: "nav" | "members") =>
      document.querySelector<HTMLElement>(panel === "nav" ? ".kc-nav" : '[role="dialog"].kc-modal--side');

    const release = () => {
      if (moved) {
        moved.style.transform = "";
        moved.style.transition = "";
        moved = null;
      }
    };

    const onStart = (e: TouchEvent) => {
      swipe = null;
      if (e.touches.length !== 1) return;
      if (!window.matchMedia(PHONE_QUERY).matches || !window.matchMedia(TOUCH_ACTIONS_QUERY).matches) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest(OWN_GESTURES) || scrollsSideways(target)) return;
      // Another dialog is open (settings, a menu…): swipes belong to it.
      if (document.querySelector('[role="dialog"]:not(.kc-modal--side)')) return;
      const { open: current, canOpenMembers: members } = latest.current;
      const nav = document.querySelector<HTMLElement>(".kc-nav");
      const t = e.touches[0];
      swipe = startSwipe(current, t.clientX, t.clientY, e.timeStamp, {
        viewportWidth: window.innerWidth,
        navWidth: nav?.getBoundingClientRect().width || window.innerWidth * 0.8,
        membersWidth: Math.min(352, window.innerWidth * 0.88),
        canOpenMembers: members,
        edgeGuard: EDGE_GUARD,
      });
    };

    const onMove = (e: TouchEvent) => {
      if (!swipe || e.touches.length !== 1) return;
      const t = e.touches[0];
      swipe = moveSwipe(swipe, t.clientX, t.clientY, e.timeStamp);
      const progress = swipeProgress(swipe);
      if (!progress || reducedMotion()) return;
      const el = panelEl(progress.panel);
      if (!el) return; // the member panel before it opens: it slides in on release
      moved = el;
      el.style.transition = "none";
      el.style.transform =
        progress.panel === "nav"
          ? `translateX(${((progress.openness - 1) * 102).toFixed(2)}%)`
          : `translateX(${((1 - progress.openness) * 100).toFixed(2)}%)`;
    };

    const onEnd = (e: TouchEvent) => {
      if (!swipe) return;
      const t = e.changedTouches[0];
      const result = t ? endSwipe(swipe, t.clientX, t.clientY, e.timeStamp) : swipe.open;
      const before = swipe.open;
      swipe = null;
      const el = moved;
      moved = null;
      // Hand the panel back to its CSS transition, change state, and only then drop the
      // finger's position, so it glides from where the finger left it to where it belongs.
      if (el) el.style.transition = "";
      if (result !== before) latest.current.onChange(result);
      if (el) requestAnimationFrame(() => requestAnimationFrame(() => { el.style.transform = ""; }));
    };

    const onCancel = () => {
      swipe = null;
      release();
    };

    document.addEventListener("touchstart", onStart, { passive: true });
    document.addEventListener("touchmove", onMove, { passive: true });
    document.addEventListener("touchend", onEnd, { passive: true });
    document.addEventListener("touchcancel", onCancel, { passive: true });
    return () => {
      document.removeEventListener("touchstart", onStart);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onEnd);
      document.removeEventListener("touchcancel", onCancel);
      release();
    };
  }, []);
}
