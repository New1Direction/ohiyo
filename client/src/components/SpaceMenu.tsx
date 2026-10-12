import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { Icon, type IconName } from "./Icon";

export type SpaceMenuItem = {
  label: string;
  icon: IconName;
  onSelect: () => void;
  /** Leave or delete: set apart at the end, in the danger colour. */
  danger?: boolean;
};

type Props = {
  name: string;
  /** In order; the danger items should come last. */
  items: SpaceMenuItem[];
  /** The space name button, so closing panels (Space options) can hand focus back to it. */
  buttonRef: RefObject<HTMLButtonElement | null>;
};

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="kc-space-name-chevron"
      style={{ transform: open ? "rotate(180deg)" : undefined }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

/** The space's name, which opens one labelled menu of what you can do in the space (like
 *  Discord). A menu button in the WAI-ARIA sense: arrow keys, Home and End move, Escape
 *  closes and returns to the name, Tab or a click outside closes it. */
export function SpaceMenu({ name, items, buttonRef }: Props) {
  // null: closed; otherwise the item that takes focus when it opens.
  const [focusOnOpen, setFocusOnOpen] = useState<number | null>(null);
  const open = focusOnOpen !== null;
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const menuId = useId();
  const buttonId = useId();

  const openAt = (index: number) => setFocusOnOpen(index);
  const close = (refocus: boolean) => {
    setFocusOnOpen(null);
    if (refocus) buttonRef.current?.focus();
  };

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
  }, [open, buttonRef]);

  const focusItem = (index: number) => {
    const count = items.length;
    if (count === 0) return;
    itemRefs.current[(index + count) % count]?.focus();
  };
  const current = () => itemRefs.current.findIndex((el) => el === document.activeElement);

  const firstDanger = items.findIndex((item) => item.danger);

  return (
    <div className="kc-space-menu-anchor">
      <button
        ref={buttonRef}
        id={buttonId}
        type="button"
        className="kc-space-name-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => (open ? close(false) : openAt(0))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            openAt(0);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            openAt(items.length - 1);
          }
        }}
      >
        <span className="truncate">{name}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          tabIndex={-1}
          aria-labelledby={buttonId}
          className="kc-space-menu"
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
              {i === firstDanger && i > 0 && <div role="separator" className="kc-space-menu-separator" />}
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
