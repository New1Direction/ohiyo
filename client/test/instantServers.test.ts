// The command palette offers Instant Servers only on a home that can make them. The hosted
// service can't, and its palette used to offer them anyway, answering "not available".
//   node --experimental-strip-types --test test/instantServers.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { availabilityFrom, offersInstantServers } from "../src/lib/instantServers.ts";

test("the server's answer says whether Instant Servers are on", () => {
  assert.equal(availabilityFrom({ available: true }), "on");
  assert.equal(availabilityFrom({ available: false }), "off");
});

test("an answer it can't read changes nothing", () => {
  // An older or self-hosted server has no such endpoint; its palette stays as it was.
  for (const body of [null, undefined, {}, { available: "no" }, [], "false"]) {
    assert.equal(availabilityFrom(body), "unknown", JSON.stringify(body));
  }
});

test("the palette offers Instant Servers unless the home says they're off", () => {
  assert.equal(offersInstantServers("off"), false);
  assert.equal(offersInstantServers("on"), true);
  assert.equal(offersInstantServers("unknown"), true);
});

test("the palette's Instant Servers entry follows that answer", () => {
  const app = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "App.tsx"), "utf8");
  const at = app.indexOf('id: "action-instant-servers"');
  assert.ok(at !== -1, "the palette still has the entry where they're on");
  assert.match(app.slice(Math.max(0, at - 400), at), /offersInstantServers\(/);
});

// ── The paid plan ─────────────────────────────────────────────────────────────

import { billingReturnFrom, planFor, readinessFrom } from "../src/lib/instantServers.ts";

const sellable = readinessFrom({ available: true, provisioner: "live", paid_plan: { available: true, price_label: "$8/month", reason: null } });

test("an older server that doesn't describe the paid plan can't sell it", () => {
  for (const body of [null, { available: true }, { available: true, paid_plan: { available: "yes" } }]) {
    const r = readinessFrom(body);
    assert.equal(r.paid.available, false, JSON.stringify(body));
    assert.ok(r.paid.reason, "it says why");
  }
  assert.equal(readinessFrom({ available: true }).provisioner, "unknown");
  assert.equal(readinessFrom({ provisioner: "simulated" }).provisioner, "simulated");
});

test("a free running server can be upgraded only where the plan is sold", () => {
  const free = { tier: "free", status: "healthy", billing: null };
  const up = planFor(free, sellable);
  assert.equal(up.action, "upgrade");
  assert.ok(up.action === "upgrade" && up.label.includes("$8/month"));

  const off = readinessFrom({ available: true, provisioner: "off", paid_plan: { available: false, price_label: "$8/month", reason: "Managed hosting is offline on this server." } });
  const no = planFor(free, off);
  assert.equal(no.action, "unavailable");
  assert.ok(no.action === "unavailable" && no.reason.includes("offline"));

  // A server that never came up can't be upgraded, sold or not.
  assert.equal(planFor({ tier: "free", status: "failed" }, sellable).action, "none");
});

test("a started checkout is not a paid plan until Stripe confirms", () => {
  const p = planFor({ tier: "free", status: "healthy", billing: { status: "checkout_pending", cancel_at_period_end: false, current_period_end: null } }, sellable);
  assert.equal(p.kind, "pending");
  assert.equal(p.badge, "Free");
  assert.equal(p.action, "upgrade", "the owner can start over");
});

test("a paid server is managed, and says when it renews, ends, or is failing", () => {
  const at = 1_900_000_000;
  const active = planFor({ tier: "paid", status: "healthy", billing: { status: "active", cancel_at_period_end: false, current_period_end: at } }, sellable);
  assert.equal(active.action, "manage");
  assert.ok(active.kind === "paid" && active.canCancel && active.note?.startsWith("Renews"));

  const ending = planFor({ tier: "paid", status: "healthy", billing: { status: "active", cancel_at_period_end: true, current_period_end: at } }, sellable);
  assert.ok(ending.kind === "paid" && !ending.canCancel && ending.note?.startsWith("Ends"));

  const failing = planFor({ tier: "paid", status: "healthy", billing: { status: "past_due", cancel_at_period_end: false, current_period_end: at } }, sellable);
  assert.ok(failing.kind === "paid" && failing.note?.includes("Payment failed"));

  // Managing billing doesn't depend on whether new plans can be sold here.
  assert.equal(planFor({ tier: "paid", status: "healthy", billing: { status: "active", cancel_at_period_end: false, current_period_end: at } }, readinessFrom(null)).action, "manage");
});

test("a cancelled plan reads as free again, and staff-set paid servers have nothing to manage", () => {
  assert.equal(planFor({ tier: "free", status: "healthy", billing: { status: "canceled", cancel_at_period_end: false, current_period_end: 1 } }, sellable).action, "upgrade");
  const comped = planFor({ tier: "paid", status: "healthy", billing: null }, sellable);
  assert.equal(comped.kind, "comped");
  assert.equal(comped.action, "none");
});

test("only Stripe's three return markers count", () => {
  assert.equal(billingReturnFrom("?instant_billing=success&instance=abc"), "success");
  assert.equal(billingReturnFrom("?instant_billing=canceled"), "canceled");
  assert.equal(billingReturnFrom("?instant_billing=portal"), "portal");
  assert.equal(billingReturnFrom("?instant_billing=paid"), null);
  assert.equal(billingReturnFrom("?invite=abc"), null);
});
