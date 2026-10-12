// What a message says, drawn from its formatting (stub: replaced in the next commit).
import type { ServerEmoji } from "../api";

export function MessageContent({ content }: { content: string; serverEmojis: ServerEmoji[]; currentUsername?: string; now?: number }) {
  return <>{content}</>;
}
