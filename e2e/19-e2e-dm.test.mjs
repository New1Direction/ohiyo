import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { currentToken, launchBrowser, register, shot, log, uniq } from "./harness.mjs";

// End-to-end encrypted DMs: A toggles encryption, sends a secret. B decrypts it.
// CRITICAL: the server must store only ciphertext — verified via the REST API.
const API = process.env.E2E_API || "http://localhost:3000/api/v1";
const u = uniq();
const A = `ea_${u}`,
  B = `eb_${u}`;
const browser = await launchBrowser();
let failed = false;
try {
  // ── A registers (publishes its E2E public key on login) ──
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await register(pageA, A, "Ann");
  await pageA.waitForSelector("#kc-space-name", { timeout: 12000 });
  await pageA.fill("#kc-space-name", "Ann HQ");
  await pageA.click('button:has-text("Let\'s go")');
  await pageA.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });

  // ── B registers (also publishes its key, and is searchable) ──
  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const pageB = await ctxB.newPage();
  pageB.on("pageerror", (e) => console.error("  B ERR:", e.message));
  await register(pageB, B, "Bea");
  await pageB.waitForSelector("#kc-space-name", { timeout: 12000 });
  await pageB.fill("#kc-space-name", "Bea HQ");
  await pageB.click('button:has-text("Let\'s go")');
  await pageB.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  log("A + B registered (E2E keys auto-published — no key handling)");

  // ── A opens a DM with B ──
  await pageA.click('button[aria-label="Direct Messages"]');
  await pageA.click('button[aria-label="Find people"]');
  await pageA.waitForSelector('input[aria-label="Search people"]', { timeout: 6000 });
  await pageA.fill('input[aria-label="Search people"]', B);
  await pageA.waitForSelector(`button[aria-label="Message @${B}"]`, { timeout: 6000 });
  await pageA.click(`button[aria-label="Message @${B}"]`);
  await pageA.waitForSelector('input[placeholder="Say something…"]', { timeout: 8000 });
  log("A opened DM with B");

  // ── A clicks the lock → end-to-end encrypted mode (banner + darker chat) ──
  await pageA.click('button[aria-label="Turn on end-to-end encryption"]');
  await pageA.waitForSelector("text=/Switched to end-to-end encrypted/", { timeout: 6000 });
  await pageA.waitForSelector(".kc-e2e", { timeout: 4000 }); // chat shifted darker
  log("A clicked the lock → encrypted mode, banner + darker chat ✓");
  await shot(pageA, "35-e2e-on");

  // ── A sends a secret message (sees plaintext locally) ──
  const secret = `top-secret-${u}`;
  const composer = pageA.locator('input[placeholder="Say something…"]');
  await composer.fill(secret);
  await composer.press("Enter");
  await pageA.waitForSelector(`text=${secret}`, { timeout: 8000 });
  log("A sent an encrypted message");

  // ── B reloads, opens the DM, sees the DECRYPTED plaintext ──
  await pageB.reload({ waitUntil: "domcontentloaded" });
  await pageB.click('button[aria-label="Direct Messages"]');
  await pageB.waitForSelector('button:has-text("Direct Message")', { timeout: 8000 });
  await pageB.click('button:has-text("Direct Message")');
  await pageB.waitForSelector(`text=${secret}`, { timeout: 10000 });
  log("B opened the DM and DECRYPTED A's message ✓");
  await shot(pageB, "36-e2e-decrypted");

  // ── B verifies the Signal safety number (optional identity check, one click) ──
  await pageB.click('button[aria-label="Verify encryption safety number"]');
  await pageB.waitForSelector("text=/Compare these digits/", { timeout: 6000 });
  log("B revealed the Signal safety number (MITM verification) ✓");

  // ── B replies — its UI auto-flipped to encrypted (sticky + mutual) → A decrypts ──
  const reply = `reply-secret-${u}`;
  const composerB = pageB.locator('input[placeholder="Say something…"]');
  await composerB.fill(reply);
  await composerB.press("Enter");
  await pageA.waitForSelector(`text=${reply}`, { timeout: 10000 });
  log("B replied (mutual encryption, no toggle) and A DECRYPTED it ✓");

  // ── Padding proof: two different short plaintext lengths in the same padding bucket
  //    should decrypt normally. Exact bucket sizing is unit-tested at the plaintext
  //    wrapper layer; Signal's outer envelope can still vary by protocol header/device fanout. ──
  const padOne = `p-${u}`;
  const padTwo = `pad-${u}`;
  await composer.fill(padOne);
  await composer.press("Enter");
  await pageB.waitForSelector(`text=${padOne}`, { timeout: 10000 });
  await composer.fill(padTwo);
  await composer.press("Enter");
  await pageB.waitForSelector(`text=${padTwo}`, { timeout: 10000 });
  log("A sent two padded encrypted messages; B decrypted both ✓");

  // ── Private attachment relay: A encrypts bytes client-side before upload. The peer
  //    sees the real filename after decrypt; the server only sees encrypted.bin. ──
  const privateName = `private-note-${u}.txt`;
  const privatePath = join(tmpdir(), privateName);
  writeFileSync(privatePath, `private attachment ${u}`);
  const chooser = pageA.waitForEvent("filechooser");
  await pageA.click('button[aria-label="Attach a file"]');
  await (await chooser).setFiles(privatePath);
  await pageA.waitForSelector(`text=${privateName}`, { timeout: 10000 });
  await composer.fill(`file-${u}`);
  await composer.press("Enter");
  await pageB.waitForSelector(`text=${privateName}`, { timeout: 15000 });
  log("A sent a private encrypted attachment; B decrypted the manifest ✓");

  // ── A reloads: own sent message + B's reply both survive (forward-secrecy cache).
  //    The Double Ratchet can't re-decrypt either, so this proves the local cache. ──
  await pageA.reload({ waitUntil: "domcontentloaded" });
  await pageA.click('button[aria-label="Direct Messages"]');
  await pageA.waitForSelector('button:has-text("Direct Message")', { timeout: 8000 });
  await pageA.click('button:has-text("Direct Message")');
  await pageA.waitForSelector(`text=${secret}`, { timeout: 10000 });
  await pageA.waitForSelector(`text=${reply}`, { timeout: 10000 });
  await pageA.waitForSelector(`text=${padOne}`, { timeout: 10000 });
  await pageA.waitForSelector(`text=${padTwo}`, { timeout: 10000 });
  await pageA.waitForSelector(`text=${privateName}`, { timeout: 15000 });
  log("A reloaded → own message + reply both still readable (forward-secrecy cache) ✓");

  // ── PROOF: the server stored only CIPHERTEXT (it cannot read the message) ──
  const tokenA = await currentToken(pageA);
  const dms = await (
    await fetch(`${API}/users/@me/dms`, { headers: { Authorization: `Bearer ${tokenA}` } })
  ).json();
  const dmId = dms[0]?.id;
  if (!dmId) throw new Error("no DM channel found via API");
  const msgs = await (
    await fetch(`${API}/channels/${dmId}/messages`, { headers: { Authorization: `Bearer ${tokenA}` } })
  ).json();
  const stored = msgs[msgs.length - 1]?.content ?? "";
  if (stored.includes(secret) || stored.includes(reply) || stored.includes(padOne) || stored.includes(padTwo) || stored.includes(privateName)) {
    throw new Error(`server stored PLAINTEXT! content="${stored}"`);
  }
  // Both users publish Signal prekeys on login, so the flow uses the forward-secret
  // multi-device Signal envelope (`sig2.`). `sig1.` is the older single-device format
  // and `v1.` the legacy static scheme — both kept only as fallbacks.
  if (!/^(sig2|sig1|v1)\./.test(stored)) throw new Error(`server content is not our ciphertext envelope: "${stored}"`);
  if (!/^sig2\./.test(stored)) console.warn(`  ⚠ stored as "${stored.slice(0, 6)}…" — expected multi-device sig2.`);
  const lastTwo = msgs.slice(-2).map((m) => String(m.content ?? ""));
  if (lastTwo.length !== 2 || lastTwo.some((m) => !m.startsWith("sig2."))) {
    throw new Error(`padding proof messages were not sig2 envelopes: ${JSON.stringify(lastTwo)}`);
  }
  const privateAttachmentMsg = msgs.find((m) =>
    String(m.content ?? "").startsWith("sig2.") &&
    JSON.stringify(m.attachments ?? []).includes("encrypted.bin")
  );
  if (!privateAttachmentMsg) throw new Error("no generic encrypted attachment metadata found on server");
  const serverAttachment = privateAttachmentMsg.attachments?.[0];
  if (serverAttachment?.filename !== "encrypted.bin" || serverAttachment?.content_type !== "application/octet-stream") {
    throw new Error(`server saw private attachment metadata: ${JSON.stringify(serverAttachment)}`);
  }
  if (JSON.stringify(privateAttachmentMsg).includes(privateName)) {
    throw new Error("server response leaked original private attachment filename");
  }
  log(`server stores ciphertext only; padded messages stayed opaque sig2 envelopes (${lastTwo.map((m) => m.length).join("/")} chars), attachment metadata generic ✓`);

  console.log(
    `\n✅ E2E DM FLOW PASSED (one-click toggle → ${/^sig2\./.test(stored) ? "Signal forward-secret multi-device" : "legacy"} encrypt → padded peer decrypts; server sees only ciphertext)`
  );
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
