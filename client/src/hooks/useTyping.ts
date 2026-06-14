import { useCallback, useEffect, useRef, useState } from "react";
import type { PublicUser } from "../api";

// How long a "typing…" indicator lingers after the last keystroke event.
const TYPING_TTL_MS = 5000;

type TypingState = Record<string, Record<string, PublicUser>>; // channelId → userId → user

/**
 * Tracks who is currently typing, per channel. Each typist auto-expires after
 * TYPING_TTL_MS unless refreshed. Ignores the current user's own echo.
 */
export function useTyping(currentUserId: string) {
  const [typing, setTyping] = useState<TypingState>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  // Clear all pending expiry timers if the owner unmounts (logout / token swap).
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const id of Object.values(pending)) clearTimeout(id);
    };
  }, []);

  const drop = useCallback((channelId: string, userId: string) => {
    setTyping((prev) => {
      if (!prev[channelId]?.[userId]) return prev;
      const channel = { ...prev[channelId] };
      delete channel[userId];
      const next = { ...prev };
      if (Object.keys(channel).length === 0) delete next[channelId];
      else next[channelId] = channel;
      return next;
    });
  }, []);

  const onTypingStart = useCallback(
    (channelId: string, user: PublicUser) => {
      if (user.id === currentUserId) return; // ignore our own broadcast echo
      const key = `${channelId}:${user.id}`;
      if (timers.current[key]) clearTimeout(timers.current[key]);
      timers.current[key] = setTimeout(() => {
        delete timers.current[key];
        drop(channelId, user.id);
      }, TYPING_TTL_MS);
      setTyping((prev) => ({
        ...prev,
        [channelId]: { ...(prev[channelId] ?? {}), [user.id]: user },
      }));
    },
    [currentUserId, drop]
  );

  // Remove someone immediately — e.g. once their message actually lands.
  const clearTyping = useCallback(
    (channelId: string, userId: string) => {
      const key = `${channelId}:${userId}`;
      if (timers.current[key]) {
        clearTimeout(timers.current[key]);
        delete timers.current[key];
      }
      drop(channelId, userId);
    },
    [drop]
  );

  const typingIn = useCallback(
    (channelId: string): PublicUser[] => Object.values(typing[channelId] ?? {}),
    [typing]
  );

  return { onTypingStart, clearTyping, typingIn };
}
