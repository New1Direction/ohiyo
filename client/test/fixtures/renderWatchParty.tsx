// Entry bundled by test/watchPartyRender.test.ts: renders the watch party to static HTML.
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WatchParty } from "../../src/components/WatchParty";

export function renderWatchParty(props: ComponentProps<typeof WatchParty>): string {
  return renderToStaticMarkup(<WatchParty {...props} />);
}
