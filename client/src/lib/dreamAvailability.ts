/**
 * Dream mode is a desktop feature: it needs room beside the video and a mouse or trackpad.
 * It is not offered on phones or touch-first tablets, including a phone held sideways, which
 * is wide but has no hover and no fine pointer. 701px matches the app's phone breakpoint.
 */
export const DREAM_MEDIA_QUERY = "(min-width: 701px) and (any-hover: hover) and (any-pointer: fine)";

export function dreamAvailable(matchMedia: ((query: string) => { matches: boolean }) | undefined): boolean {
  // Where the browser cannot answer (an old engine, server rendering), keep the feature
  // rather than hide it.
  return matchMedia ? matchMedia(DREAM_MEDIA_QUERY).matches : true;
}
