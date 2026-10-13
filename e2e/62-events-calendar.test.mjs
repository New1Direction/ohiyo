import { launchBrowser, ORIGIN, register, shot, settle, log, uniq, PASS } from "./harness.mjs";

// Events, end to end. A plans a hangout in the space's voice channel starting in about two
// minutes and is down as Going; B finds it on the calendar and says Going too, and A's open
// card shows B going without a reload. B is reminded (the "starting soon" banner, with Join
// voice) within a sweep of the server's background loop. A edits the title and B sees the new
// one; A cancels it and B is told. Screenshots: the month and agenda views and the event card
// in dark and light, and the agenda on a phone.
const u = uniq();
const A = `eva_${u}`, B = `evb_${u}`;
const COMPOSER = 'textarea[placeholder*="Say something to #general"]';
const browser = await launchBrowser();
let failed = false;

async function openEvents(page) {
  await page.click('.channel-sidebar button[aria-haspopup="menu"]');
  await page.click('.channel-sidebar [role="menuitem"]:has-text("Events")');
  await page.waitForSelector("text=📅 Events", { timeout: 6000 });
}

// The local wall-clock time `minutes` from now, as a datetime-local input wants it.
function localInputValue(page, minutes) {
  return page.evaluate((m) => {
    const d = new Date(Date.now() + m * 60_000);
    d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() + 1);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }, minutes);
}

try {
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const pageA = await ctxA.newPage();
  pageA.on("pageerror", (e) => console.error("  A ERR:", e.message));
  await register(pageA, A, "Avi");
  await pageA.waitForSelector("#kc-space-name", { timeout: 12000 });
  await pageA.fill("#kc-space-name", "Calendar HQ");
  await pageA.click('button:has-text("Let\'s go")');
  await pageA.waitForSelector(COMPOSER, { timeout: 12000 });
  await pageA.click('button[aria-label="Invite people"]');
  await pageA.waitForFunction(() => {
    const el = document.querySelector('input[aria-label="Invite link"]');
    return el && el.value.includes("invite=");
  }, { timeout: 6000 });
  const link = await pageA.inputValue('input[aria-label="Invite link"]');
  await pageA.keyboard.press("Escape");

  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const pageB = await ctxB.newPage();
  pageB.on("pageerror", (e) => console.error("  B ERR:", e.message));
  await pageB.goto(ORIGIN, { waitUntil: "domcontentloaded" });
  await pageB.evaluate(() => localStorage.clear());
  await pageB.goto(link, { waitUntil: "domcontentloaded" });
  await pageB.waitForSelector("text=Create an account", { timeout: 8000 });
  await pageB.click("text=Create an account");
  await pageB.fill('input[autocomplete="username"]', B);
  await pageB.fill('input[autocomplete="nickname"]', "Bex");
  await pageB.fill("#kc-password", PASS);
  await pageB.click('button:has-text("Create my account")');
  await pageB.waitForSelector('button:has-text("Accept invite")', { timeout: 12000 });
  await pageB.click('button:has-text("Accept invite")');
  await pageB.waitForSelector(COMPOSER, { timeout: 12000 });
  log("A + B in Calendar HQ");

  // ── A plans a hangout in the voice channel, about two minutes out ──
  await openEvents(pageA);
  await pageA.click('button:has-text("New event")');
  await pageA.fill('input[aria-label="Event title"]', "Voice hangout");
  await pageA.fill('input[aria-label="Starts"]', await localInputValue(pageA, 2));
  await pageA.selectOption('select[aria-label="Where"]', { label: "🔊 General" });
  await pageA.fill('textarea[aria-label="Event details"]', "Bring a game, snacks optional.");
  await pageA.click('button:has-text("Create event")');
  await pageA.waitForSelector('article[aria-label="Voice hangout"]', { timeout: 8000 });
  await pageA.waitForSelector('article[aria-label="Voice hangout"] [role="group"][aria-label="Your answer"] button[aria-pressed="true"]:has-text("Going")', { timeout: 6000 });
  log("A created the event in the voice channel and is down as Going ✓");
  await pageA.click('button:has-text("Back to calendar")');
  await pageA.waitForSelector('[role="grid"] [aria-current="date"]:has-text("Voice hangout")', { timeout: 6000 });
  await shot(pageA, "62-events-month-dark");
  log("the month grid shows it on today ✓");

  // ── B finds it on the calendar and says Going ──
  await openEvents(pageB);
  await pageB.click('[role="grid"] [aria-current="date"] button:has-text("Voice hangout")');
  const goingB = pageB.locator('article[aria-label="Voice hangout"] [role="group"][aria-label="Your answer"] button:has-text("Going")');
  await goingB.click();
  await pageB.waitForSelector('article[aria-label="Voice hangout"] [role="group"][aria-label="Your answer"] button[aria-pressed="true"]:has-text("Going")', { timeout: 6000 });
  log("B said Going ✓");

  // ── A's open card shows B going, live ──
  await pageA.click('[role="grid"] [aria-current="date"] button:has-text("Voice hangout")');
  await pageA.waitForSelector('article[aria-label="Voice hangout"] :text("Bex")', { timeout: 8000 });
  log("A's card shows Bex going without a reload ✓");
  await shot(pageA, "62-events-card-dark");

  // ── B is reminded within a sweep (the server's background loop runs every 20 s) ──
  const banner = pageB.locator('[role="status"]:has-text("Voice hangout")');
  await banner.waitFor({ timeout: 50_000 });
  const bannerText = await banner.innerText();
  // innerText follows the kicker's text-transform (upper case).
  if (!/starting soon|event starting/i.test(bannerText)) throw new Error(`banner says: ${bannerText}`);
  if ((await banner.locator('button:has-text("Join voice")').count()) !== 1) throw new Error("no Join voice on the banner");
  log("B got the reminder banner with Join voice ✓");
  await shot(pageB, "62-events-reminder");
  await banner.locator('button[aria-label="Dismiss"]').click();
  // A is going too, so A got the same reminder in the same sweep: put it away.
  const bannerA = pageA.locator('[role="status"]:has-text("Voice hangout") button[aria-label="Dismiss"]');
  await bannerA.waitFor({ timeout: 5000 }).catch(() => {});
  if (await bannerA.count()) await bannerA.click();

  // ── A edits the title; B sees it ──
  await pageA.click('article[aria-label="Voice hangout"] button:has-text("Edit")');
  await pageA.fill('input[aria-label="Event title"]', "Voice hangout, round two");
  await pageA.click('button:has-text("Save changes")');
  await pageA.waitForSelector('article[aria-label="Voice hangout, round two"]', { timeout: 8000 });
  await pageB.waitForSelector('article[aria-label="Voice hangout, round two"]', { timeout: 8000 });
  log("A renamed it and B's card followed ✓");

  // ── The agenda ──
  await pageA.click('button:has-text("Back to calendar")');
  await pageA.click('button[aria-pressed]:has-text("Agenda")');
  await pageA.waitForSelector('section[aria-label="Today"] :text("Voice hangout, round two")', { timeout: 6000 });
  await shot(pageA, "62-events-agenda-dark");

  // ── Light theme ──
  await pageA.keyboard.press("Escape");
  await pageA.locator('button[aria-label="Settings"]').first().click();
  await pageA.locator(".kc-settings-nav button", { hasText: "Appearance" }).click();
  await pageA.click('button[aria-label="Use theme: Ohiyo Light"]');
  await pageA.keyboard.press("Escape");
  await settle(pageA, 300);
  await openEvents(pageA);
  await pageA.click('button[aria-pressed]:has-text("Month")');
  await pageA.waitForSelector('[role="grid"]', { timeout: 6000 });
  await shot(pageA, "62-events-month-light");
  await pageA.click('[role="grid"] [aria-current="date"] button:has-text("Voice hangout")');
  await pageA.waitForSelector('article[aria-label="Voice hangout, round two"]', { timeout: 6000 });
  await shot(pageA, "62-events-card-light");
  await pageA.click('button:has-text("Back to calendar")');
  await pageA.click('button[aria-pressed]:has-text("Agenda")');
  await shot(pageA, "62-events-agenda-light");
  log("month, card and agenda in the light theme ✓");

  // ── A phone opens on the agenda ──
  await pageB.click('button:has-text("Back to calendar")');
  await pageB.setViewportSize({ width: 390, height: 844 });
  await settle(pageB, 300);
  await pageB.waitForSelector('section[aria-label="Today"] :text("Voice hangout, round two")', { timeout: 6000 });
  if ((await pageB.locator('[role="grid"]').count()) !== 0) throw new Error("a phone should show the agenda, not the grid");
  await shot(pageB, "62-events-agenda-phone");
  await pageB.click('section[aria-label="Today"] button:has-text("Voice hangout, round two")');
  await pageB.waitForSelector('article[aria-label="Voice hangout, round two"]', { timeout: 6000 });
  await shot(pageB, "62-events-card-phone");
  log("a phone shows the agenda ✓");

  // ── A cancels; B is told ──
  await pageA.click('section[aria-label="Today"] button:has-text("Voice hangout, round two")');
  await pageA.click('article[aria-label="Voice hangout, round two"] button:has-text("Cancel event")');
  await pageA.click('[role="dialog"] button:has-text("Yes, cancel it")');
  await pageA.waitForSelector('article[aria-label="Voice hangout, round two"] :text("Cancelled")', { timeout: 6000 });
  await pageB.waitForSelector('[role="status"]:has-text("Voice hangout, round two"):has-text("cancelled")', { timeout: 8000 });
  await pageB.waitForSelector('article[aria-label="Voice hangout, round two"] :text("Cancelled")', { timeout: 8000 });
  if ((await pageB.locator('article[aria-label="Voice hangout, round two"] [role="group"][aria-label="Your answer"]').count()) !== 0) {
    throw new Error("a cancelled event still takes answers");
  }
  log("A cancelled it; B got the notice and the card says Cancelled ✓");

  console.log("\n✅ EVENTS CALENDAR PASSED (voice location · RSVP · live going list · reminder · edit · agenda · phone · cancel)");
} catch (err) {
  failed = true;
  console.error("\n❌ FAILED:", err.message);
} finally {
  await browser.close();
}
process.exitCode = failed ? 1 : 0;
