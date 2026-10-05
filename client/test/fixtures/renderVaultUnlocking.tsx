// Entry bundled by test/vaultUnlocking.test.ts: renders the screen shown while the key vault
// unlocks to static HTML with react-dom/server.
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { VaultUnlockingScreen } from "../../src/components/VaultUnlocking";

export function renderUnlocking(props: ComponentProps<typeof VaultUnlockingScreen>): string {
  return renderToStaticMarkup(<VaultUnlockingScreen {...props} />);
}
