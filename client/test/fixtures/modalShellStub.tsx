// Test stand-in for ModalShell: the real one portals into document.body, which the
// server renderer can't do, so render the dialog's content in place.
import type { ReactNode } from "react";

export function ModalShell({ labelledBy, children }: { onClose: () => void; labelledBy: string; maxWidthClass?: string; children: ReactNode }) {
  return (
    <div role="dialog" aria-labelledby={labelledBy}>
      {children}
    </div>
  );
}
