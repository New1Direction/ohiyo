// Whether this home offers Instant Servers. The hosted service can't make them, and the
// command palette shouldn't offer something that only answers "not available".

export type InstantServersAvailability = "unknown" | "on" | "off";

/** Reads the answer of GET /instances/available. Anything else (an older or self-hosted
 *  server without that endpoint) is "unknown", which changes nothing. */
export function availabilityFrom(body: unknown): InstantServersAvailability {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "unknown";
  const available = (body as { available?: unknown }).available;
  if (available === true) return "on";
  if (available === false) return "off";
  return "unknown";
}

/** Whether to show Instant Servers in the command palette. */
export function offersInstantServers(availability: InstantServersAvailability): boolean {
  return availability !== "off";
}

// ── The paid plan ─────────────────────────────────────────────────────────────

/** "live": real machines. "simulated": a development server's stand-in, nothing really
 *  runs. "off": no Instant Servers here. "unknown": an older server that doesn't say. */
export type Provisioner = "live" | "simulated" | "off" | "unknown";

export type Readiness = {
  provisioner: Provisioner;
  paid: { available: boolean; priceLabel: string | null; reason: string | null };
};

const NOT_OFFERED = "This server doesn't offer the paid plan.";

/** Reads GET /instances/available. An older server that doesn't describe the paid plan
 *  can't sell it, so the plan reads as unavailable rather than guessed. */
export function readinessFrom(body: unknown): Readiness {
  const b = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  const provisioner: Provisioner =
    b.provisioner === "live" || b.provisioner === "simulated" || b.provisioner === "off" ? b.provisioner : "unknown";
  const plan = b.paid_plan !== null && typeof b.paid_plan === "object" ? (b.paid_plan as Record<string, unknown>) : null;
  const available = plan?.available === true;
  return {
    provisioner,
    paid: {
      available,
      priceLabel: typeof plan?.price_label === "string" ? plan.price_label : null,
      reason: available ? null : typeof plan?.reason === "string" ? plan.reason : NOT_OFFERED,
    },
  };
}

export type InstanceBilling = {
  status: string;
  cancel_at_period_end: boolean;
  current_period_end: number | null;
};

type PlanInput = { tier: string; status: string; billing?: InstanceBilling | null };

/** What one server's plan is and what the owner can do about it. */
export type Plan =
  | { kind: "free"; badge: string; action: "upgrade"; label: string }
  | { kind: "free"; badge: string; action: "unavailable"; reason: string }
  | { kind: "free"; badge: string; action: "none"; reason: string }
  | { kind: "pending"; badge: string; action: "upgrade"; label: string; note: string }
  | { kind: "paid"; badge: string; action: "manage"; note: string | null; canCancel: boolean }
  | { kind: "comped"; badge: string; action: "none"; note: string };

function day(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

const PAID_STATUSES = new Set(["active", "trialing", "past_due"]);

export function planFor(inst: PlanInput, readiness: Readiness): Plan {
  const billing = inst.billing ?? null;
  const subscribed = billing !== null && PAID_STATUSES.has(billing.status);
  if (inst.tier === "paid" && !subscribed) {
    // Turned on by an operator rather than bought: nothing to manage in billing.
    return { kind: "comped", badge: "Paid", action: "none", note: "Paid plan set by Ohiyo staff." };
  }
  if (subscribed) {
    let note: string | null = null;
    if (billing.status === "past_due") note = "Payment failed. Stripe is retrying; update your card to keep the paid plan.";
    else if (billing.cancel_at_period_end)
      note = billing.current_period_end ? `Ends ${day(billing.current_period_end)}, then moves to the free plan.` : "Ends at the end of this period, then moves to the free plan.";
    else if (billing.current_period_end) note = `Renews ${day(billing.current_period_end)}.`;
    return { kind: "paid", badge: "Paid · stays on", action: "manage", note, canCancel: !billing.cancel_at_period_end };
  }
  const label = `Upgrade · ${readiness.paid.priceLabel ?? "paid plan"}`;
  if (!["healthy", "sleeping", "waking"].includes(inst.status)) {
    return { kind: "free", badge: "Free", action: "none", reason: "The server has to be running before it can be upgraded." };
  }
  if (!readiness.paid.available) {
    return { kind: "free", badge: "Free", action: "unavailable", reason: readiness.paid.reason ?? NOT_OFFERED };
  }
  if (billing?.status === "checkout_pending") {
    return { kind: "pending", badge: "Free", action: "upgrade", label, note: "Checkout started. The paid plan turns on as soon as Stripe confirms the payment." };
  }
  return { kind: "free", badge: "Free", action: "upgrade", label };
}

/** Where Stripe sent the browser back to: `?instant_billing=success|canceled|portal`. */
export type BillingReturn = "success" | "canceled" | "portal";

export function billingReturnFrom(search: string): BillingReturn | null {
  const v = new URLSearchParams(search).get("instant_billing");
  return v === "success" || v === "canceled" || v === "portal" ? v : null;
}

export function billingReturnMessage(kind: BillingReturn): { text: string; tone: "success" | "info" } {
  switch (kind) {
    case "success":
      return { text: "Checkout finished. Your server moves to the paid plan as soon as Stripe confirms the payment, usually within a minute.", tone: "success" };
    case "canceled":
      return { text: "Checkout cancelled. Nothing was charged.", tone: "info" };
    case "portal":
      return { text: "Back from billing. Changes show up here once Stripe confirms them.", tone: "info" };
  }
}
