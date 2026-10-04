// Test stand-in for react-virtualized-auto-sizer: server rendering has no layout to
// measure, so give the message list a fixed size and its rows actually render.
import type { ReactNode } from "react";

export function AutoSizer({ renderProp }: { renderProp: (size: { width: number; height: number }) => ReactNode }) {
  return <>{renderProp({ width: 800, height: 4000 })}</>;
}
