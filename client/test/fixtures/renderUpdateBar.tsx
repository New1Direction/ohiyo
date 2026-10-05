// Entry bundled by the update bar test: renders the bar to static HTML.
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UpdateBar } from "../../src/components/UpdateBar";

export function renderUpdateBar(props: ComponentProps<typeof UpdateBar>): string {
  return renderToStaticMarkup(<UpdateBar {...props} />);
}
