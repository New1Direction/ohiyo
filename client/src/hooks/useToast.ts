import { useCallback, useState } from "react";

export type Toast = {
  id: string;
  text: string;
  type: "info" | "success" | "error" | "warn";
};

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const push = useCallback(
    (text: string, type: Toast["type"] = "info") => {
      const id = Math.random().toString(36).slice(2);
      const toast: Toast = { id, text, type };
      setToasts((prev) => [...prev, toast]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, 3500);
    },
    []
  );

  return { toasts, push };
}
