import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";

export type ChatRowMenuItem = { label: string; icon: IconName; onSelect: () => void };

type Props = {
  /** The chat's name, which labels the menu. */
  name: string;
  /** Where it was opened (a right-click, a long-press, or the row for the keyboard's menu key). */
  x: number;
  y: number;
  items: ChatRowMenuItem[];
  onClose: () => void;
};

/** A channel's or DM's own menu, opened by right-clicking or long-pressing its row (like
 *  Discord). Arrow keys, Home and End move; Escape, Tab or a click outside closes it. */
export function ChatRowMenu({ name, x, y, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep it on screen, then put focus on the first item.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (el) {
      const { width, height } = el.getBoundingClientRect();
      const margin = 8;
      setPos({
        left: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
        top: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
      });
    }
    itemRefs.current[0]?.focus();
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: Event) => {
      const target = e.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, [onClose]);

  const focusItem = (index: number) => {
    const count = items.length;
    if (count) itemRefs.current[(index + count) % count]?.focus();
  };
  const current = () => itemRefs.current.findIndex((el) => el === document.activeElement);

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={name}
      tabIndex={-1}
      className="kc-space-menu kc-row-menu"
      style={{ left: pos.left, top: pos.top }}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          focusItem(current() + 1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          focusItem(current() - 1);
        } else if (e.key === "Home") {
          e.preventDefault();
          focusItem(0);
        } else if (e.key === "End") {
          e.preventDefault();
          focusItem(items.length - 1);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === "Tab") {
          onClose();
        }
      }}
    >
      {items.map((item, i) => (
        <button
          key={item.label}
          ref={(el) => {
            itemRefs.current[i] = el;
          }}
          type="button"
          role="menuitem"
          tabIndex={-1}
          className="kc-space-menu-item"
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          <Icon name={item.icon} size={16} />
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Long-press for touch screens: after this long without moving, the row's menu opens and the
 *  tap that follows doesn't also open the chat. */
const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

export function useLongPress(onLongPress: (x: number, y: number) => void) {
  const timer = useRef<number | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const cancel = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  };
  useEffect(() => cancel, []);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      fired.current = false;
      if (e.pointerType !== "touch") return;
      start.current = { x: e.clientX, y: e.clientY };
      const { clientX, clientY } = e;
      timer.current = window.setTimeout(() => {
        fired.current = true;
        timer.current = null;
        onLongPress(clientX, clientY);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = start.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > MOVE_TOLERANCE_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    /** True once, right after a long-press: the click it ends in should do nothing. */
    consumeLongPress: () => {
      const was = fired.current;
      fired.current = false;
      return was;
    },
  };
}
