import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

type Props = {
  onClose: () => void;
  /** id of the heading element inside, for aria-labelledby */
  labelledBy: string;
  maxWidthClass?: string;
  children: React.ReactNode;
};

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), textarea, [href], [tabindex]:not([tabindex="-1"])';

/** Accessible modal chrome: portal + blurred backdrop + Escape + focus trap. */
export function ModalShell({ onClose, labelledBy, maxWidthClass = "max-w-md", children }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  // Keep onClose current without re-running the open/teardown effect.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    // Remember what was focused so we can hand it back on close.
    const returnTo = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseRef.current();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      returnTo?.focus?.();
    };
  }, []);

  function trapTab(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Tab") return;
    const nodes = ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
    if (!nodes || !nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className="kc-backdrop" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`kc-modal ${maxWidthClass}`}
        style={{ padding: "var(--space-8)" }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        {children}
      </div>
    </div>,
    document.body
  );
}
