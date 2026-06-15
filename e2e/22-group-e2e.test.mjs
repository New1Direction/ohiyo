import { launchBrowser, register, log, uniq } from "./harness.mjs";

// Group E2E via Sender Keys: A, B, C in a group DM all enable E2E (each distributes a
// sender key). One ciphertext per message is decrypted by every member; the server
// only ever stores opaque `grp1.` ciphertext.
const API = process.env.E2E_API || "http://localhost:3000/api/v1";
const u = uniq();
const A = `ga_${u}`,
  B = `gb_${u}`,
  C = `gc_${u}`;
const browser = await launchBrowser();
let failed = false;

async function setup(name, username, display, space) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 820 } });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error(`  ${name} ERR:`, e.message));
  await register(page, username, display);
  await page.waitForSelector("text=/Welcome in,/", { timeout: 12000 });
  await page.fill("#kc-space-name", space);
  await page.click('button:has-text("Let\'s go")');
  await page.waitForSelector('input[placeholder*="Say something to #general"]', { timeout: 12000 });
  return page;
}

async function openGroup(page) {
  await page.click('button[aria-label="Direct Messages"]');
  await page.waitForSelector('button:has-text("Direct Message")', { timeout: 8000 });
  await page.click('button:has-text("Direct Message")');
  await page.waitForSelector('input[placeholder*="Say something"]', { timeout: 8000 });
}

try {
  const pageA = await setup("A", A, "Ag", "Ag HQ");
  const pageB = await setup("B", B, "Bg", "Bg HQ");
  const pageC = await setup("C", C, "Cg", "Cg HQ");
  const idOf = (p) => p.evaluate(() => window.__kikkacordUser?.id);
  const [bId, cId, tokenA] = await Promise.all([
    idOf(pageB),
    idOf(pageC),
    pageA.evaluate(() => localStorage.getItem("token")),
  ]);
  log("A, B, C registered");

  // A creates a group DM with B and C (UI group-creation is a follow-up; the crypto
  // flow is what we're proving here).
  const grp = await (
    await fetch(`${API}/users/@me/group-dms`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenA}`, "content-type": "application/json" },
      body: JSON.stringify({ recipient_ids: [bId, cId], name: "Squad" }),
    })
  ).json();
  if (!grp.id) throw new Error(`group create failed: ${JSON.stringify(grp)}`);
  log("group DM created");

  // Each opens the group (it arrives live via ChannelCreate → DM list).
  await openGroup(pageA);
  await openGroup(pageB);
  await openGroup(pageC);
  log("all three opened the group");

  // Each enables E2E → distributes their sender key to the others.
  for (const page of [pageA, pageB, pageC]) {
    await page.click('button[aria-label="Turn on end-to-end encryption"]');
    await page.waitForSelector("text=/Switched to end-to-end encrypted/", { timeout: 6000 });
  }
  log("all three enabled E2E (sender keys distributed over pairwise sessions)");
  await pageA.waitForTimeout(2000); // let the SKDMs propagate + install

  // A sends a group message → BOTH B and C decrypt the same ciphertext.
  const secret = `squad-${u}`;
  const cA = pageA.locator('input[placeholder*="Say something"]');
  await cA.fill(secret);
  await cA.press("Enter");
  await pageA.waitForSelector(`text=${secret}`, { timeout: 8000 });
  await pageB.waitForSelector(`text=${secret}`, { timeout: 10000 });
  await pageC.waitForSelector(`text=${secret}`, { timeout: 10000 });
  log("A's group message decrypted by BOTH B and C ✓");

  // B replies → A and C decrypt (bidirectional sender keys).
  const reply = `creply-${u}`;
  const cB = pageB.locator('input[placeholder*="Say something"]');
  await cB.fill(reply);
  await cB.press("Enter");
  await pageA.waitForSelector(`text=${reply}`, { timeout: 10000 });
  await pageC.waitForSelector(`text=${reply}`, { timeout: 10000 });
  log("B's reply decrypted by A and C ✓");

  // PROOF: the server stored only group ciphertext (it can't read the group).
  const msgs = await (
    await fetch(`${API}/channels/${grp.id}/messages`, { headers: { Authorization: `Bearer ${tokenA}` } })
  ).json();
  const stored = msgs[msgs.length - 1]?.content ?? "";
  if (stored.includes(reply) || stored.includes(secret)) throw new Error(`server stored PLAINTEXT: "${stored}"`);
  if (!/^grp1\./.test(stored)) throw new Error(`not a group ciphertext envelope: "${stored}"`);
  log(`server stores group ciphertext only: "${stored.slice(0, 28)}…" ✓`);

  console.log("\n✅ GROUP E2E (SENDER KEYS) PASSED (one ciphertext, every member decrypts; server stays blind)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
