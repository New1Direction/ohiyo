// Entry bundled by test/e2eCache.test.ts: the plaintext cache and the desktop vault from
// one bundle, so a test can run the cache on the vault-backed store.
export { cachePlaintext, getCachedPlaintext, sweepPlaintextCache } from "../../src/lib/e2eCache";
export { initVaultBackend } from "../../src/lib/tauriVault";
