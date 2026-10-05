// Entry bundled by the link player render tests: one card, closed or already opened,
// rendered to static HTML with react-dom/server.
import { renderToStaticMarkup } from "react-dom/server";
import { EmbedOpenContext, PlayableEmbed } from "../../src/components/LinkEmbeds";
import { embedKey, linkEmbedFor } from "../../src/lib/linkEmbeds";

type Options = { showPreview: boolean; openHeight?: number; title?: string };

export function renderLinkEmbed(url: string, { showPreview, openHeight, title }: Options): string {
  const embed = linkEmbedFor(url);
  if (!embed) return "";
  const key = embedKey("m1", url);
  const heights = new Map<string, number>(openHeight === undefined ? [] : [[key, openHeight]]);
  return renderToStaticMarkup(
    <EmbedOpenContext.Provider value={{ heights, set() {} }}>
      <PlayableEmbed url={url} embed={embed} openKey={key} showPreview={showPreview} title={title} />
    </EmbedOpenContext.Provider>
  );
}
