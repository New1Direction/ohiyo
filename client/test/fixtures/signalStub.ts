// Stand-in for src/lib/signal.ts in bundles that only need its storage hook: the real
// module pulls in libsignal's curve code, which can't load under node.
export function setSignalBackend(): void {}
