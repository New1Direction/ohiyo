// A push subscription belongs to the session that registered it, so the server stops
// nudging it once that session ends (sign out everywhere, Not me, a password change).
// On signing in, this browser registers its existing subscription again for the new
// session, so its own notifications carry on. It never asks for permission to do it.
//   node --experimental-strip-types --test test/pushRenew.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { renewPushRegistration, type PushRegistration } from "../src/lib/pushRenew.ts";

const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: "key", auth: "secret" };

function deps(permission: string, sub: typeof subscription | null) {
  const sent: PushRegistration[] = [];
  return {
    sent,
    deps: {
      permission: () => permission,
      subscription: async () => sub,
      deviceName: "Web browser",
      register: async (body: PushRegistration) => {
        sent.push(body);
      },
    },
  };
}

test("an existing subscription is registered again for the new session", async () => {
  const d = deps("granted", subscription);
  assert.equal(await renewPushRegistration(d.deps), true);
  assert.deepEqual(d.sent, [
    { platform: "web", endpoint: subscription.endpoint, p256dh: "key", auth: "secret", device_name: "Web browser" },
  ]);
});

test("nothing is registered without permission already given", async () => {
  for (const permission of ["default", "denied", "unsupported"]) {
    const d = deps(permission, subscription);
    assert.equal(await renewPushRegistration(d.deps), false);
    assert.deepEqual(d.sent, [], permission);
  }
});

test("nothing is registered when this browser never subscribed", async () => {
  const d = deps("granted", null);
  assert.equal(await renewPushRegistration(d.deps), false);
  assert.deepEqual(d.sent, []);
});

test("a failed request is not an error for the caller", async () => {
  const d = deps("granted", subscription);
  d.deps.register = async () => {
    throw new Error("offline");
  };
  assert.equal(await renewPushRegistration(d.deps), false);
});
