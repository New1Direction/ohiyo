// Calls in DMs: which rings are still waiting for an answer, and what a call log in the chat
// says to each person.
//   node --experimental-strip-types --test test/dmCall.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  callCountsAsUnread,
  callLogText,
  formatCallDuration,
  nextRings,
  type IncomingRing,
} from "../src/lib/dmCall.ts";

const ring = (channelId: string, ringUntil = 1000): IncomingRing => ({
  channelId,
  messageId: `m-${channelId}`,
  callerId: "ann",
  callerName: "Ann",
  video: false,
  ringUntil,
});

test("a ring shows once, even if it arrives again from another of your devices' connections", () => {
  let rings = nextRings([], { type: "ring", ring: ring("dm1") });
  rings = nextRings(rings, { type: "ring", ring: ring("dm1") });
  assert.deepEqual(rings.map((r) => r.channelId), ["dm1"]);
});

test("rings from two chats both wait, and stopping one leaves the other", () => {
  let rings = nextRings([], { type: "ring", ring: ring("dm1") });
  rings = nextRings(rings, { type: "ring", ring: ring("dm2") });
  rings = nextRings(rings, { type: "stop", channelId: "dm1" });
  assert.deepEqual(rings.map((r) => r.channelId), ["dm2"]);
});

test("a ring ends by itself once its time is up", () => {
  let rings = nextRings([], { type: "ring", ring: ring("dm1", 100) });
  rings = nextRings(rings, { type: "ring", ring: ring("dm2", 200) });
  assert.deepEqual(nextRings(rings, { type: "tick", now: 150 }).map((r) => r.channelId), ["dm2"]);
  assert.deepEqual(nextRings(rings, { type: "tick", now: 99 }).map((r) => r.channelId), ["dm1", "dm2"]);
});

test("a stop for a chat that isn't ringing changes nothing", () => {
  const rings = nextRings([], { type: "ring", ring: ring("dm1") });
  assert.deepEqual(nextRings(rings, { type: "stop", channelId: "nope" }), rings);
});

test("call lengths read like Discord's", () => {
  assert.equal(formatCallDuration(0), "0s");
  assert.equal(formatCallDuration(45), "45s");
  assert.equal(formatCallDuration(63), "1m 03s");
  assert.equal(formatCallDuration(723), "12m 03s");
  assert.equal(formatCallDuration(3723), "1h 02m");
});

const ann = { callerId: "ann", callerName: "Ann" };

test("a ringing call says who is calling, and the caller sees Calling", () => {
  assert.equal(callLogText({ state: "ringing" }, { viewerId: "bea", ...ann }), "Ann is calling…");
  assert.equal(callLogText({ state: "ringing" }, { viewerId: "ann", ...ann }), "Calling…");
});

test("an ongoing call says who started it", () => {
  assert.equal(callLogText({ state: "ongoing" }, { viewerId: "bea", ...ann }), "Ann started a call");
  assert.equal(callLogText({ state: "ongoing" }, { viewerId: "ann", ...ann }), "You started a call");
});

test("an ended call says how long it lasted", () => {
  assert.equal(
    callLogText({ state: "ended", duration_secs: 723 }, { viewerId: "bea", ...ann }),
    "Call ended · 12m 03s",
  );
});

test("a missed call reads from each side", () => {
  assert.equal(callLogText({ state: "missed" }, { viewerId: "bea", ...ann }), "Missed call from Ann");
  assert.equal(callLogText({ state: "missed" }, { viewerId: "ann", ...ann }), "No answer");
});

test("a declined call names who declined, and you see that it was you", () => {
  const call = { state: "declined" as const, declined_by: "bea" };
  assert.equal(callLogText(call, { viewerId: "ann", declinerName: "Bea", ...ann }), "Bea declined");
  assert.equal(callLogText(call, { viewerId: "bea", declinerName: "Bea", ...ann }), "You declined");
});

test("only a call you missed counts as unread", () => {
  assert.equal(callCountsAsUnread({ state: "missed" }, "bea", "ann"), true);
  assert.equal(callCountsAsUnread({ state: "missed" }, "ann", "ann"), false);
  for (const state of ["ringing", "ongoing", "ended", "declined"] as const) {
    assert.equal(callCountsAsUnread({ state }, "bea", "ann"), false, state);
  }
});
