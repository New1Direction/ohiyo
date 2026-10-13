// The heading over the people in a call. A voice channel lists "People in General"; a DM
// call is "Call with Bea", and a group chat's call is "Call in <group>" ("Group call" when
// the group has no name). It used to say "People in Bea" for a DM.
//   node --experimental-strip-types --test test/callTitle.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { callHeading } from "../src/lib/callTitle.ts";

test("a voice channel lists the people in it", () => {
  assert.deepEqual(callHeading("voice", "General"), { kicker: "Voice room", title: "People in General" });
});

test("a one-to-one DM call is a call with that person", () => {
  assert.deepEqual(callHeading("dm", "Bea"), { kicker: "Call", title: "Call with Bea" });
});

test("a group chat's call is a call in the group", () => {
  assert.deepEqual(callHeading("group", "Pizza club"), { kicker: "Group call", title: "Call in Pizza club" });
});

test("a group with no name is just a group call", () => {
  assert.deepEqual(callHeading("group", ""), { kicker: "Group call", title: "Group call" });
  assert.deepEqual(callHeading("group", null), { kicker: "Group call", title: "Group call" });
});

test("a DM whose name isn't known yet doesn't say 'Call with undefined'", () => {
  assert.equal(callHeading("dm", undefined).title, "Call");
});
