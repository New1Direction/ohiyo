import { useCallback, useEffect, useRef, useState } from "react";

export type Toast = {
  id: string;
  text: string;
  type: "info" | "success" | "error" | "warn";
};

const TOAST_TTL_MS = 3500;

export function useToast() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  // Track pending removal timers so they can be cleared on unmount — otherwise
  // a fired setTimeout would call setToasts after the component is gone.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const push = useCallback(
    (text: string, type: Toast["type"] = "info") => {
      const id = Math.random().toString(36).slice(2);
      const toast: Toast = { id, text, type };
      setToasts((prev) => [...prev, toast]);
      const timer = setTimeout(() => {
        timersRef.current.delete(id);
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, TOAST_TTL_MS);
      timersRef.current.set(id, timer);
    },
    []
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return { toasts, push };
}
