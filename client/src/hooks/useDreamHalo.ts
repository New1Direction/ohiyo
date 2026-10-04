import { useLayoutEffect, type RefObject } from "react";
import { dreamHaloHole } from "../lib/dreamHalo";

/** Geometry only. No contentWindow access, video sampling, capture, or duplicate player. */
export function useDreamHalo(
  playerRef: RefObject<HTMLDivElement | null>,
  haloRef: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  source: string,
) {
  useLayoutEffect(() => {
    const player = playerRef.current;
    const halo = haloRef.current;
    const media = player?.querySelector("iframe, video");
    if (!enabled || !halo || !player || !(media instanceof HTMLElement)) return;
    const supports = window.CSS?.supports;
    if (!supports || !supports("mask-composite", "exclude") ||
      !(supports("backdrop-filter", "blur(1px)") || supports("-webkit-backdrop-filter", "blur(1px)")) ||
      typeof window.ResizeObserver !== "function") return;
    const update = () => {
      // Invalid/zero geometry fails closed: a transparent room, never a covered player.
      delete halo.dataset.ready;
      const hole = dreamHaloHole(media.getBoundingClientRect(), halo.getBoundingClientRect(), halo.clientWidth, halo.clientHeight);
      if (!hole) return;
      for (const [name, value] of Object.entries(hole)) halo.style.setProperty(`--halo-${name}`, `${value}px`);
      halo.dataset.ready = "true";
    };
    update();
    const observer = new window.ResizeObserver(update);
    observer.observe(media);
    observer.observe(player);
    observer.observe(halo);
    const header = player.querySelector(".kc-watch-header");
    if (header) observer.observe(header);
    const mediaContainer = player.querySelector(".kc-watch-media");
    if (mediaContainer) observer.observe(mediaContainer);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      delete halo.dataset.ready;
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [enabled, source, playerRef, haloRef]);
}
