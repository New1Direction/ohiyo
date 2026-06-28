import test from "node:test";
import assert from "node:assert/strict";
import {
  activationCompletedCount,
  isActivationDismissed,
  loadActivation,
  markActivation,
  setActivationDismissed,
} from "../src/lib/activation.ts";

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
  },
  configurable: true,
});

Object.defineProperty(globalThis, "window", {
  value: { dispatchEvent: () => true },
  configurable: true,
});

test("activation milestones are per-user and monotonic", () => {
  store.clear();
  assert.equal(activationCompletedCount(loadActivation("u1")), 0);
  const first = markActivation("u1", "account", 100);
  assert.equal(first.account, 100);
  assert.equal(activationCompletedCount(first), 1);

  const again = markActivation("u1", "account", 200);
  assert.equal(again.account, 100);
  assert.equal(loadActivation("u2").account, null);
});

test("activation dismissal is per-user", () => {
  store.clear();
  assert.equal(isActivationDismissed("u1"), false);
  setActivationDismissed("u1", true);
  assert.equal(isActivationDismissed("u1"), true);
  assert.equal(isActivationDismissed("u2"), false);
  setActivationDismissed("u1", false);
  assert.equal(isActivationDismissed("u1"), false);
});
