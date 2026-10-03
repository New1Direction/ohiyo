// Entry bundled by the settings render tests: renders SettingsModal to static HTML with
// react-dom/server so a test can check what a tab shows on open.
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SettingsModal } from "../../src/components/settings/SettingsModal";

export function renderSettingsModal(props: ComponentProps<typeof SettingsModal>): string {
  return renderToStaticMarkup(<SettingsModal {...props} />);
}
