import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconName } from "./Icon";

type Item = { label: string; icon: IconName; onSelect: () => void; danger?: boolean };

/** A thread's ⋯ menu in its header: Rename thread and Delete thread, for whoever started it or
 *  someone who manages the channel. Same surface as the space menu; a menu button in the
 *  WAI-ARIA sense (arrow keys move, Escape closes and returns to the button). */
export function ThreadOptionsMenu({ onRename, onDelete }: { onRename?: () => void; onDelete?: () => void }) {
  const items: Item[] = [
    ...(onRename ? [{ label: "Rename thread", icon: "edit" as const, onSelect: onRename }] : []),
    ...(onDelete ? [{ label: "Delete thread", icon: "trash" as const, onSelect: onDelete, danger: true }] : []),
  ];
  const [focusOnOpen, setFocusOnOpen] = useState<number | null>(null);
  const open = focusOnOpen !== null;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  const buttonId = useId();

  useLayoutEffect(() => {
    if (focusOnOpen !== null) itemRefs.current[focusOnOpen]?.focus();
  }, [focusOnOpen]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && (menuRef.current?.contains(target) || buttonRef.current?.contains(target))) return;
      setFocusOnOpen(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (items.length === 0) return null;
  const close = (refocus: boolean) => {
    setFocusOnOpen(null);
    if (refocus) buttonRef.current?.focus();
  };
  const focusItem = (index: number) => itemRefs.current[(index + items.length) % items.length]?.focus();
  const current = () => itemRefs.current.findIndex((el) => el === document.activeElement);

  return (
    <div className="kc-space-menu-anchor kc-thread-options">
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        className="kc-thread-header-button kc-interactive"
        aria-label="Thread options"
        title="Thread options"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : setFocusOnOpen(0))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setFocusOnOpen(0);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setFocusOnOpen(items.length - 1);
          }
        }}
      >
        <Icon name="more" size={18} />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          tabIndex={-1}
          aria-labelledby={buttonId}
          className="kc-space-menu kc-thread-options-menu"
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
              close(true);
            } else if (e.key === "Tab") {
              close(false);
            }
          }}
        >
          {items.map((item, i) => (
            <div key={item.label} role="none" className="kc-space-menu-row">
              {item.danger && i > 0 && <div role="separator" className="kc-space-menu-separator" />}
              <button
                ref={(el) => {
                  itemRefs.current[i] = el;
                }}
                type="button"
                role="menuitem"
                tabIndex={-1}
                className={`kc-space-menu-item${item.danger ? " is-danger" : ""}`}
                onClick={() => {
                  close(false);
                  item.onSelect();
                }}
              >
                <Icon name={item.icon} size={16} />
                <span>{item.label}</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
