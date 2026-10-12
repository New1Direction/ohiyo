// Entry bundled by the message formatting test: renders one message's content to HTML.
import { renderToStaticMarkup } from "react-dom/server";
import { MessageContent } from "../../src/components/MessageMarkdown";
import type { ServerEmoji } from "../../src/api";

export function renderMessageContent(content: string, serverEmojis: ServerEmoji[] = [], currentUsername = "", now?: number): string {
  return renderToStaticMarkup(<MessageContent content={content} serverEmojis={serverEmojis} currentUsername={currentUsername} now={now} />);
}
