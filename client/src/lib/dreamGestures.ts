/** Gesture math is independent of media playback and never changes room state. */
export const DREAM_DRAG_THRESHOLD = 6;
export const DREAM_DOUBLE_TAP_MS = 320;
export type DreamPoint = { x: number; y: number; at: number };

export function clampDreamVolume(value: number): number {
  return Number.isFinite(value) ? Math.round(Math.min(100, Math.max(0, value))) : 0;
}

/** Relative movement preserves the player's actual volume when a drag begins. */
export function dreamDragVolume(startVolume: number, startY: number, currentY: number, height: number): number {
  return clampDreamVolume(startVolume + ((startY - currentY) / Math.max(1, height)) * 100);
}

export function dreamGestureMoved(start: DreamPoint, current: DreamPoint): boolean {
  return Math.hypot(current.x - start.x, current.y - start.y) > DREAM_DRAG_THRESHOLD;
}

export function isDreamDoubleTap(previous: DreamPoint | null, current: DreamPoint): boolean {
  return previous !== null && current.at >= previous.at && current.at - previous.at <= DREAM_DOUBLE_TAP_MS
    && Math.hypot(current.x - previous.x, current.y - previous.y) <= 24;
}

export function dreamVolumeKey(volume: number, key: string): number | null {
  if (key === 'ArrowUp' || key === 'ArrowRight') return clampDreamVolume(volume + 5);
  if (key === 'ArrowDown' || key === 'ArrowLeft') return clampDreamVolume(volume - 5);
  if (key === 'PageUp') return clampDreamVolume(volume + 10);
  if (key === 'PageDown') return clampDreamVolume(volume - 10);
  if (key === 'Home') return 0;
  if (key === 'End') return 100;
  return null;
}
