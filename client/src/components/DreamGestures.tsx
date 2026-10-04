import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  clampDreamVolume, dreamDragVolume, dreamGestureMoved, dreamVolumeKey, isDreamDoubleTap,
  type DreamPoint,
} from "../lib/dreamGestures";

type DreamGesturesProps = {
  /** null until the real player reports its volume. Never guess a starting level. */
  volume: number | null;
  onVolumeChange: (volume: number) => void;
  onTogglePlayback: () => void;
  isHost: boolean;
  paused: boolean;
  /** E.g. a mobile player that does not support programmatic volume changes. */
  disabledReason?: string;
};
type Drag = { id: number; start: DreamPoint; volume: number; height: number; moved: boolean };
const point = (event: ReactPointerEvent): DreamPoint => ({ x: event.clientX, y: event.clientY, at: event.timeStamp });

/** Render only in Dream mode, as a sibling of the media. CSS must keep the rail in
 * the right gutter and the surround below the media; neither covers an iframe. */
export function DreamGestures({ volume, onVolumeChange, onTogglePlayback, isHost, paused, disabledReason }: DreamGesturesProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const touch = useRef<{ id: number; start: DreamPoint; moved: boolean } | null>(null);
  const previousTap = useRef<DreamPoint | null>(null);
  const suppressDoubleClickUntil = useRef(0);
  const indicatorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [adjusting, setAdjusting] = useState(false);
  const available = volume !== null && Number.isFinite(volume) && !disabledReason;
  const value = volume === null ? 0 : clampDreamVolume(volume);

  useEffect(() => {
    const rail = railRef.current;
    return () => {
      clearTimeout(indicatorTimer.current);
      const active = drag.current;
      if (active && rail?.hasPointerCapture(active.id)) rail.releasePointerCapture(active.id);
      drag.current = null;
      touch.current = null;
      previousTap.current = null;
    };
  }, []);

  function hideIndicator() {
    clearTimeout(indicatorTimer.current);
    indicatorTimer.current = setTimeout(() => setAdjusting(false), 700);
  }
  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    hideIndicator();
  }

  return (
    <div className="kc-watch-gestures" data-dream-no-toggle="true">
      <button
        type="button"
        className="kc-watch-gesture-surround"
        aria-label={isHost ? `${paused ? "Play" : "Pause"} together. Double-click or double-tap the surround.` : "Playback is controlled by the host"}
        disabled={!isHost}
        onClick={(event) => { if (isHost && event.detail === 0) onTogglePlayback(); }}
        onDoubleClick={(event) => {
          if (isHost && event.timeStamp > suppressDoubleClickUntil.current) onTogglePlayback();
        }}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          touch.current = { id: event.pointerId, start: point(event), moved: false };
        }}
        onPointerMove={(event) => {
          const active = touch.current;
          if (active?.id === event.pointerId && dreamGestureMoved(active.start, point(event))) active.moved = true;
        }}
        onPointerUp={(event) => {
          const active = touch.current;
          if (!active || active.id !== event.pointerId) return;
          touch.current = null;
          const current = point(event);
          if (active.moved || dreamGestureMoved(active.start, current) || current.at - active.start.at > 500) {
            previousTap.current = null;
            suppressDoubleClickUntil.current = current.at + 400;
            return;
          }
          if (event.pointerType === "mouse") return; // Native dblclick handles mouse.
          suppressDoubleClickUntil.current = current.at + 500; // Ignore touch's synthetic dblclick.
          if (isHost && isDreamDoubleTap(previousTap.current, current)) {
            previousTap.current = null;
            onTogglePlayback();
          } else previousTap.current = current;
        }}
        onPointerCancel={() => { touch.current = null; previousTap.current = null; }}
        onPointerLeave={() => {
          // Non-hover pointers leave immediately after pointerup. Keep that
          // completed tap so a second touch can form a double-tap; only an
          // in-progress gesture leaving the surround cancels the sequence.
          if (touch.current) previousTap.current = null;
          touch.current = null;
        }}
      />
      <div
        ref={railRef}
        className={`kc-watch-volume-rail${adjusting ? " is-adjusting" : ""}`}
        role="slider"
        tabIndex={0}
        aria-label="Your listening volume"
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={available ? value : undefined}
        aria-valuetext={available ? `${value}%` : disabledReason || "Waiting for player volume"}
        aria-disabled={!available}
        title={disabledReason || "Slide up or down to adjust your volume. Arrow keys also work."}
        onPointerDown={(event) => {
          event.stopPropagation();
          if (!available || !event.isPrimary || event.button !== 0 || drag.current) return;
          event.preventDefault();
          event.currentTarget.focus({ preventScroll: true });
          event.currentTarget.setPointerCapture(event.pointerId);
          clearTimeout(indicatorTimer.current);
          drag.current = { id: event.pointerId, start: point(event), volume: value, height: event.currentTarget.getBoundingClientRect().height, moved: false };
          setAdjusting(true);
        }}
        onPointerMove={(event) => {
          const active = drag.current;
          if (!active || active.id !== event.pointerId || !available) return;
          event.preventDefault();
          active.moved ||= dreamGestureMoved(active.start, point(event));
          if (active.moved) onVolumeChange(dreamDragVolume(active.volume, active.start.y, event.clientY, active.height));
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        onKeyDown={(event) => {
          if (!available) return;
          const next = dreamVolumeKey(value, event.key);
          if (next === null) return;
          event.preventDefault();
          event.stopPropagation();
          onVolumeChange(next);
          setAdjusting(true);
          hideIndicator();
        }}
        onBlur={() => { if (!drag.current) setAdjusting(false); }}
      >
        <span className="kc-watch-volume-indicator" aria-hidden="true" hidden={!adjusting}>
          {value}%
        </span>
      </div>
    </div>
  );
}
