// What a desktop notification says about a message's author, and whether a message counts
// as mentioning you. A webhook is another service posting, not a person: its notifications
// say "(app)", and naming you doesn't count as a mention, so it can't get through a mute.
//   node --experimental-strip-types --test test/messageNotify.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { mentionsMe, notificationTitle } from "../src/lib/messageNotify.ts";

test("a webhook's notification is titled as an app", () => {
  assert.equal(notificationTitle({ display_name: "Deploy bot", bot: true }), "Deploy bot (app)");
  assert.equal(notificationTitle({ display_name: "Sam" }), "Sam");
});

test("a webhook naming you doesn't count as mentioning you; a person does", () => {
  assert.equal(mentionsMe("@sam the deploy broke", { bot: true }, "sam"), false);
  assert.equal(mentionsMe("@everyone the deploy broke", { bot: true }, "sam"), false);
  assert.equal(mentionsMe("@sam look", {}, "sam"), true);
  assert.equal(mentionsMe("@sam look", { bot: false }, "sam"), true);
});
