// Entry bundled by test/signOut.test.ts: renders the sign-out confirmation to static HTML.
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SignOutDialog } from "../../src/components/SignOutDialog";

export function renderSignOutDialog(props: ComponentProps<typeof SignOutDialog>): string {
  return renderToStaticMarkup(<SignOutDialog {...props} />);
}
