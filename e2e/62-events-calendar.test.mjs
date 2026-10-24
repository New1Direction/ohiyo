import assert from "node:assert/strict";
import { launchBrowser, ORIGIN, register, shot, settle, log, uniq, PASS } from "./harness.mjs";

// Events, end to end. A plans a hangout in the space's voice channel starting in about two
// minutes and is down as Going; B finds it on the calendar and says Going too, and A's open
// card shows B going without a reload. B is reminded (the "starting soon" banner, with Join
// voice) within a sweep of the server's background loop. A edits the title and B sees the new
// one; A cancels it and B is told. Screenshots: the month and agenda views and the event card
// in dark and light, and the agenda on a phone.
checkDateBoundaries();
// Deterministic regression checks without a running stack or Chromium.
if (process.argv.includes("--dates-only")) process.exit(0);
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
// Also accepts an explicit instant so the midnight regression is reproducible.
function localInputValue({ minutes, now = Date.now() }) {
  const d = new Date(now + minutes * 60_000);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function eventCell(start) {
  return `[role="grid"] [data-day="${start.slice(0, 10)}"]`;
}

function monthDistance(from, to) {
  const [fy, fm] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  return (ty - fy) * 12 + tm - fm;
}

function agendaLabel({ start, now = Date.now(), locale = navigator.language }) {
  const date = new Date(start);
  const today = new Date(now);
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return new Intl.DateTimeFormat(locale, { weekday: "long", month: "long", day: "numeric" }).format(date);
}

// Reopening Events resets its month. Navigate to the event's month, even when the
// next day isn't included among the current grid's trailing days (or is next year).
async function monthEvent(page, start, title) {
  const selected = page.locator('[role="grid"] [aria-selected="true"]');
  await selected.waitFor({ timeout: 6000 });
  const distance = monthDistance(await selected.getAttribute("data-day"), start.slice(0, 10));
  for (let i = 0; i < Math.abs(distance); i++) {
    const previous = await selected.getAttribute("data-day");
    await page.getByRole("button", { name: distance > 0 ? "Next month" : "Previous month", exact: true }).click();
    await page.waitForFunction((day) => document.querySelector('[role="grid"] [aria-selected="true"]')?.getAttribute("data-day") !== day, previous);
  }
  const month = await page.evaluate((value) => new Intl.DateTimeFormat(navigator.language, { month: "long", year: "numeric" }).format(new Date(value)), start);
  assert.equal(await page.locator('[role="grid"]').getAttribute("aria-label"), month);
  const event = page.locator(eventCell(start)).getByRole("button", { name: title, exact: true });
  await event.waitFor({ timeout: 6000 });
  return event;
}

async function agendaEvent(page, start, title) {
  const section = page.locator(".kc-cal-agenda section").filter({ has: page.getByText(title, { exact: true }) });
  await section.waitFor({ timeout: 6000 });
  // EventsModal refreshes 'now' every 30 s. Recompute the expected label while
  // waiting so a midnight during the test can't leave a stale Tomorrow selector.
  const deadline = Date.now() + 35_000;
  let expected, actual;
  do {
    expected = await page.evaluate(agendaLabel, { start });
    actual = await section.getAttribute("aria-label");
    if (actual === expected) return section.getByRole("button").filter({ has: page.getByText(title, { exact: true }) });
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  assert.equal(actual, expected, "the event is grouped under its scheduled day");
}

function checkDateBoundaries() {
  for (const [now, expected, months, label] of [
    ["2026-10-24T12:00:00", "2026-10-24T12:03", 0, "Today"],
    ["2026-10-24T23:58:00", "2026-10-25T00:01", 0, "Tomorrow"],
    ["2026-10-31T23:58:00", "2026-11-01T00:01", 1, "Tomorrow"],
    ["2026-12-31T23:58:00", "2027-01-01T00:01", 1, "Tomorrow"],
    ["2028-02-28T23:58:00", "2028-02-29T00:01", 0, "Tomorrow"],
  ]) {
    const start = localInputValue({ minutes: 2, now: new Date(now).getTime() });
    assert.equal(start, expected);
    assert.equal(eventCell(start), `[role="grid"] [data-day="${expected.slice(0, 10)}"]`);
    assert.equal(monthDistance(now.slice(0, 10), start.slice(0, 10)), months);
    assert.equal(agendaLabel({ start, now: new Date(now).getTime(), locale: "en-US" }), label);
    assert.equal(agendaLabel({ start, now: new Date(start).getTime(), locale: "en-US" }), "Today");
  }
  log("date selectors: same day, midnight, month/year rollover and leap day ✓");
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
  const starts = await pageA.evaluate(localInputValue, { minutes: 2 });
  await pageA.fill('input[aria-label="Starts"]', starts);
  await pageA.selectOption('select[aria-label="Where"]', { label: "🔊 General" });
  await pageA.fill('textarea[aria-label="Event details"]', "Bring a game, snacks optional.");
  await pageA.click('button:has-text("Create event")');
  await pageA.waitForSelector('article[aria-label="Voice hangout"]', { timeout: 8000 });
  await pageA.waitForSelector('article[aria-label="Voice hangout"] [role="group"][aria-label="Your answer"] button[aria-pressed="true"]:has-text("Going")', { timeout: 6000 });
  log("A created the event in the voice channel and is down as Going ✓");
  await pageA.click('button:has-text("Back to calendar")');
  await monthEvent(pageA, starts, "Voice hangout");
  await shot(pageA, "62-events-month-dark");
  log(`the month grid shows it on ${starts.slice(0, 10)} ✓`);

  // ── B finds it on the calendar and says Going ──
  await openEvents(pageB);
  await (await monthEvent(pageB, starts, "Voice hangout")).click();
  const goingB = pageB.locator('article[aria-label="Voice hangout"] [role="group"][aria-label="Your answer"] button:has-text("Going")');
  await goingB.click();
  await pageB.waitForSelector('article[aria-label="Voice hangout"] [role="group"][aria-label="Your answer"] button[aria-pressed="true"]:has-text("Going")', { timeout: 6000 });
  log("B said Going ✓");

  // ── A's open card shows B going, live ──
  await (await monthEvent(pageA, starts, "Voice hangout")).click();
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
  await agendaEvent(pageA, starts, "Voice hangout, round two");
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
  await monthEvent(pageA, starts, "Voice hangout, round two");
  await shot(pageA, "62-events-month-light");
  await (await monthEvent(pageA, starts, "Voice hangout, round two")).click();
  await pageA.waitForSelector('article[aria-label="Voice hangout, round two"]', { timeout: 6000 });
  await shot(pageA, "62-events-card-light");
  await pageA.click('button:has-text("Back to calendar")');
  await pageA.click('button[aria-pressed]:has-text("Agenda")');
  await agendaEvent(pageA, starts, "Voice hangout, round two");
  await shot(pageA, "62-events-agenda-light");
  log("month, card and agenda in the light theme ✓");

  // ── A phone opens on the agenda ──
  await pageB.click('button:has-text("Back to calendar")');
  await pageB.setViewportSize({ width: 390, height: 844 });
  await settle(pageB, 300);
  await agendaEvent(pageB, starts, "Voice hangout, round two");
  if ((await pageB.locator('[role="grid"]').count()) !== 0) throw new Error("a phone should show the agenda, not the grid");
  await shot(pageB, "62-events-agenda-phone");
  await (await agendaEvent(pageB, starts, "Voice hangout, round two")).click();
  await pageB.waitForSelector('article[aria-label="Voice hangout, round two"]', { timeout: 6000 });
  await shot(pageB, "62-events-card-phone");
  log("a phone shows the agenda ✓");

  // ── A cancels; B is told ──
  await (await agendaEvent(pageA, starts, "Voice hangout, round two")).click();
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
