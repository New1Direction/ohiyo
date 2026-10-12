import { useCallback, useEffect, useState } from "react";
import { api, type Message, type PublicUser, type ServerEmoji } from "../api";
import type { GatewayEvent } from "../gateway";
import type { PluginManager } from "../plugins/registry";
import type { ThreadSummary } from "../lib/threads";
import { ChatPane } from "./ChatPane";

type Props = {
  token: string;
  thread: ThreadSummary;
  /** The channel the thread hangs off, for "in #general". */
  parentName: string;
  currentUserId: string;
  currentUsername: string;
  currentUser: PublicUser;
  pluginManager: PluginManager;
  serverEmojis: ServerEmoji[];
  mentionables: PublicUser[];
  onlineUserIds: Set<string>;
  onToast: (text: string, type?: "info" | "success" | "error") => void;
  onClose: () => void;
  /** Listen to the gateway; returns a function that stops listening. */
  subscribe: (handler: (event: GatewayEvent) => void) => () => void;
  onOpenDm?: (user: PublicUser) => void | Promise<void>;
  onBlockUser?: (user: PublicUser) => void | Promise<void>;
  onReportUser?: (user: PublicUser) => void | Promise<void>;
  onReportMessage?: (msg: Message) => void;
};

/** One reaction change applied to a message list (as the main chat does it). */
function withReaction(
  messages: Message[],
  update: { message_id: string; emoji: string; user_id: string; added: boolean },
  myId: string
): Message[] {
  return messages.map((m) => {
    if (m.id !== update.message_id) return m;
    const reactions = m.reactions ?? [];
    const existing = reactions.find((r) => r.emoji === update.emoji);
    const isMe = update.user_id === myId;
    if (existing) {
      const count = existing.count + (update.added ? 1 : -1);
      if (count <= 0) return { ...m, reactions: reactions.filter((r) => r.emoji !== update.emoji) };
      return {
        ...m,
        reactions: reactions.map((r) => (r.emoji === update.emoji ? { ...r, count, me: isMe ? update.added : r.me } : r)),
      };
    }
    return update.added ? { ...m, reactions: [...reactions, { emoji: update.emoji, count: 1, me: isMe }] } : m;
  });
}

/**
 * A thread, open beside its channel (on a phone, over it). It keeps its own messages:
 * loaded when it opens, kept current from the gateway, sent straight to the thread.
 */
export function ThreadPanel({
  token,
  thread,
  parentName,
  currentUserId,
  currentUsername,
  currentUser,
  pluginManager,
  serverEmojis,
  mentionables,
  onlineUserIds,
  onToast,
  onClose,
  subscribe,
  onOpenDm,
  onBlockUser,
  onReportUser,
  onReportMessage,
}: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const threadId = thread.id;

  useEffect(() => {
    let live = true;
    setLoading(true);
    setMessages([]);
    api
      .listMessages(token, threadId)
      .then((msgs) => {
        if (live) setMessages(msgs);
      })
      .catch(() => {
        if (live) onToast("Couldn't load this thread.", "error");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // onToast is a fresh function on every App render; the thread id is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, threadId]);

  useEffect(
    () =>
      subscribe((event) => {
        switch (event.t) {
          case "MessageCreate":
            if (event.d.channel_id === threadId) {
              const msg = event.d;
              setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
            }
            break;
          case "MessageUpdate":
            if (event.d.channel_id === threadId) {
              const msg = event.d;
              setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
            }
            break;
          case "MessageDelete":
            if (event.d.channel_id === threadId) {
              const id = event.d.id;
              setMessages((prev) => prev.filter((m) => m.id !== id));
            }
            break;
          case "ReactionUpdate":
            if (event.d.channel_id === threadId) {
              const update = event.d;
              setMessages((prev) => withReaction(prev, update, currentUserId));
            }
            break;
          default:
            break;
        }
      }),
    [subscribe, threadId, currentUserId]
  );

  const handleSend = useCallback(
    async (content: string, attachmentIds?: string[], replyTo?: string | null) => {
      const tempId = `temp-${Date.now()}`;
      const optimistic: Message = {
        id: tempId,
        channel_id: threadId,
        author: currentUser,
        content,
        created_at: Math.floor(Date.now() / 1000),
        edited_at: null,
        attachments: null,
        reactions: [],
        _state: "pending",
      };
      setMessages((prev) => [...prev, optimistic]);
      try {
        const created = await api.sendMessage(token, threadId, content, attachmentIds, replyTo);
        setMessages((prev) => {
          const without = prev.filter((m) => m.id !== tempId);
          return without.some((m) => m.id === created.id) ? without : [...without, created];
        });
      } catch {
        setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, _state: "failed" } : m)));
        onToast("Couldn't send to the thread.", "error");
      }
    },
    [token, threadId, currentUser, onToast]
  );

  return (
    <section className="kc-thread-panel" aria-label={`Thread: ${thread.name}`}>
      <ChatPane
        channel={thread}
        messages={messages}
        currentUserId={currentUserId}
        currentUsername={currentUsername}
        token={token}
        pluginManager={pluginManager}
        serverEmojis={serverEmojis}
        onSend={handleSend}
        onDiscardFailed={(id) => setMessages((prev) => prev.filter((m) => m.id !== id))}
        onToast={onToast}
        isLoading={loading}
        onEditMessage={(id, content) => {
          api.editMessage(token, threadId, id, content).catch(() => onToast("Couldn't edit that message.", "error"));
        }}
        onDeleteMessage={(id) => {
          api
            .deleteMessage(token, threadId, id)
            .then(() => setMessages((prev) => prev.filter((m) => m.id !== id)))
            .catch(() => onToast("Couldn't delete that message.", "error"));
        }}
        onReportMessage={onReportMessage}
        onOpenDm={onOpenDm}
        onBlockUser={onBlockUser}
        onReportUser={onReportUser}
        mentionables={mentionables}
        onlineUserIds={onlineUserIds}
        threadView={{ parentName, starterDeleted: thread.starter_deleted, onClose }}
      />
    </section>
  );
}
