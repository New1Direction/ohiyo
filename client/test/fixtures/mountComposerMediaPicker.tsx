import { flushSync as act } from "react-dom";
import { createRoot } from "react-dom/client";
import { ComposerMediaPicker } from "../../src/components/ComposerMediaPicker";
export { act };

type Gif = { id: string; title: string; url: string; preview: string };

/** The composer's emoji/GIF picker with every choice recorded. */
export function mountComposerMediaPicker(
  element: HTMLElement,
  opts: { gifsAvailable: boolean; tab: "emoji" | "gif"; gifResults?: Gif[] },
) {
  const calls: string[] = [];
  const root = createRoot(element);
  // The picker grew a gifsAvailable prop; the props object is built loosely so this fixture
  // also mounts the version from before it.
  const props: Record<string, unknown> = {
    tab: opts.tab,
    onTab: (t: string) => calls.push(`tab ${t}`),
    emojiQuery: "",
    onEmojiQuery: () => {},
    serverEmojis: [],
    onPickEmoji: (e: string) => calls.push(`emoji ${e}`),
    onPickCustomEmoji: () => {},
    gifsAvailable: opts.gifsAvailable,
    gifQuery: "",
    onGifQuery: (q: string) => calls.push(`gif-query ${q}`),
    gifResults: opts.gifResults ?? [],
    gifLoading: false,
    gifError: false,
    gifUrl: "",
    onGifUrl: () => {},
    onSendGif: (url: string) => calls.push(`send ${url}`),
  };
  const Picker = ComposerMediaPicker as unknown as (p: Record<string, unknown>) => JSX.Element;
  act(() => root.render(<Picker {...props} />));
  return { calls, unmount: () => act(() => root.unmount()) };
}
