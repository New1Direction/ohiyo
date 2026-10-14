import assert from "node:assert/strict";
import { launchBrowser, register, uniq, ORIGIN, log, shot } from "./harness.mjs";

// Browser contract for billing recovery actions. Auth/onboarding are real; instance
// views and the portal are fixtures. Rust's instance_billing suite tests the matching
// HTTP endpoints, database and Stripe adapter with signed events and failure injection.
const browser = await launchBrowser();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const row = (id, name, tier, status) => ({
    id, name, tier, status: "healthy", subdomain: `${id}-fixture`, region: "iad",
    billing: status ? { status, cancel_at_period_end: false, current_period_end: null } : null,
  });
  const instances = [row("paid", "Paid community", "paid", "active"), row("unpaid", "Payment recovery", "free", "unpaid"), row("free", "Free community", "free", null)];
  await page.route("**/api/v1/instances/available", route => route.fulfill({ json: { available: true, provisioner: "simulated", paid_plan: { available: true, price_label: "$8/month", reason: null } } }));
  await page.route("**/api/v1/instances", route => route.fulfill({ json: instances }));
  let portalRequests = 0;
  await page.route("**/api/v1/billing/portal", route => {
    assert.equal(route.request().method(), "POST");
    assert.match(route.request().headers().authorization, /^Bearer /);
    portalRequests++;
    return route.fulfill({ json: { url: `${ORIGIN}/billing-test-portal` } });
  });
  await page.route("**/billing-test-portal", route => route.fulfill({ contentType: "text/plain", body: "Test billing portal — no payment processed" }));
  await register(page, `billing_${uniq()}`, "Billing check");
  await page.waitForSelector("#kc-space-name", { timeout: 12000 });
  await page.fill("#kc-space-name", "Billing test space");
  await page.getByRole("button", { name: "Let's go" }).click();
  await page.waitForSelector('textarea[placeholder*="Say something to #general"]', { timeout: 12000 });
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox", { name: "Search channels and DMs" }).fill("Instant Servers");
  await page.getByRole("option", { name: /Create or manage Instant Servers/ }).click();
  await page.getByRole("heading", { name: "Paid community" }).waitFor();
  const card = name => page.getByRole("heading", { name, exact: true }).locator("xpath=../../..");
  assert.equal(await card("Paid community").getByRole("button", { name: "Sleep", exact: true }).count(), 0);
  assert.equal(await card("Free community").getByRole("button", { name: "Sleep", exact: true }).count(), 1);
  const recovery = card("Payment recovery");
  assert.equal(await recovery.getByRole("button", { name: /Upgrade/ }).count(), 0);
  assert.equal(await recovery.getByRole("button", { name: "Cancel plan" }).count(), 0);
  await recovery.getByText(/Your subscription needs attention/).waitFor();
  await shot(page, "63-instant-billing-recovery");
  await recovery.getByRole("button", { name: "Manage billing" }).click();
  await page.waitForURL(`${ORIGIN}/billing-test-portal`);
  assert.equal(portalRequests, 1);
  log("paid servers cannot sleep; free control can; unpaid billing opens the portal, not another checkout ✓");
  console.log("\n✅ INSTANT BILLING UI PASSED (fixture responses, no real charges)");
} finally {
  await browser.close();
}
