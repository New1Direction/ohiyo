// Entry bundled by test/vaultLockedScreen.test.ts: renders the locked-vault screen and the
// reset confirmation to static HTML with react-dom/server.
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResetDeviceConfirm, VaultLockedScreen } from "../../src/components/VaultLockedScreen";

export function renderLockedScreen(props: ComponentProps<typeof VaultLockedScreen>): string {
  return renderToStaticMarkup(<VaultLockedScreen {...props} />);
}

export function renderResetConfirm(props: ComponentProps<typeof ResetDeviceConfirm>): string {
  return renderToStaticMarkup(<ResetDeviceConfirm {...props} />);
}
