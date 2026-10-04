// Entry bundled by test/chatPaneRender.test.ts: renders ChatPane (and its poll-composer
// slot, which only opens after a click) to static HTML with react-dom/server so the
// unit tests can assert on what the chat shows.
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as chatPane from "../../src/components/ChatPane";

export function renderChatPane(props: ComponentProps<typeof chatPane.ChatPane>): string {
  return renderToStaticMarkup(<chatPane.ChatPane {...props} />);
}

export function renderPollComposerSlot(props: ComponentProps<typeof chatPane.PollComposerSlot>): string {
  // Read through the namespace so this file still bundles against a ChatPane that
  // predates the slot (the test then fails on the missing export, not on the build).
  const Slot = chatPane.PollComposerSlot;
  if (typeof Slot !== "function") throw new Error("ChatPane has no PollComposerSlot export");
  return renderToStaticMarkup(<Slot {...props} />);
}
