// The words and numbers behind the moderation tools: the lengths a time out and a channel's
// slowmode can take, the invite options, how long until someone may post again, what a
// timed-out member is told, and how the moderation log names each action.
//   node --experimental-strip-types --test test/moderationTools.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INVITE_EXPIRY_CHOICES,
  INVITE_MAX_USES_CHOICES,
  SLOWMODE_CHOICES,
  TIMEOUT_CHOICES,
  describeModAction,
  inviteSummary,
  slowmodeLabel,
  slowmodeWait,
  timeoutNotice,
} from "../src/lib/moderation.ts";
import { PERM, PERM_LABELS } from "../src/permissions.ts";
import { moderationRefusal } from "../src/lib/apiErrors.ts";

test("time outs come in the six lengths the server accepts", () => {
  assert.deepEqual(
    TIMEOUT_CHOICES.map((c) => c.seconds),
    [60, 300, 600, 3600, 86400, 604800],
  );
  assert.deepEqual(
    TIMEOUT_CHOICES.map((c) => c.label),
    ["60 seconds", "5 minutes", "10 minutes", "1 hour", "1 day", "1 week"],
  );
});

test("slowmode offers off and seven lengths", () => {
  assert.deepEqual(SLOWMODE_CHOICES.map((c) => c.seconds), [0, 5, 10, 30, 60, 300, 900, 3600]);
  assert.equal(SLOWMODE_CHOICES[0].label, "Off");
  assert.equal(slowmodeLabel(0), "Off");
  assert.equal(slowmodeLabel(10), "10 seconds");
  assert.equal(slowmodeLabel(60), "1 minute");
  assert.equal(slowmodeLabel(900), "15 minutes");
  assert.equal(slowmodeLabel(3600), "1 hour");
});

test("invite links can expire and run out", () => {
  assert.deepEqual(
    INVITE_EXPIRY_CHOICES.map((c) => c.seconds),
    [1800, 3600, 21600, 43200, 86400, 604800, null],
  );
  assert.equal(INVITE_EXPIRY_CHOICES.at(-1)?.label, "Never");
  assert.deepEqual(INVITE_MAX_USES_CHOICES.map((c) => c.uses), [null, 1, 5, 10, 25, 50, 100]);
  assert.equal(INVITE_MAX_USES_CHOICES[0].label, "No limit");
});

test("an invite says how long it lasts and how many uses it has left, and never more", () => {
  const now = Date.UTC(2026, 9, 12, 12, 0, 0);
  const sec = now / 1000;
  assert.equal(inviteSummary({ expires_at: null, max_uses: null, uses: 0 }, now), "Never expires · no limit");
  assert.equal(inviteSummary({ expires_at: sec + 7 * 86400, max_uses: null, uses: 0 }, now), "Expires in 7 days · no limit");
  assert.equal(inviteSummary({ expires_at: sec + 1800, max_uses: 1, uses: 0 }, now), "Expires in 30 minutes · 1 use left");
  assert.equal(inviteSummary({ expires_at: null, max_uses: 10, uses: 3 }, now), "Never expires · 7 uses left");
  assert.equal(inviteSummary({ expires_at: sec - 1, max_uses: null, uses: 0 }, now), "Expired");
  assert.equal(inviteSummary({ expires_at: null, max_uses: 5, uses: 5 }, now), "Used up");
});

test("slowmode counts down from the last message", () => {
  const sent = 1_000_000;
  assert.equal(slowmodeWait(null, 10, sent), 0, "nothing sent yet");
  assert.equal(slowmodeWait(sent, 0, sent + 1), 0, "slowmode off");
  assert.equal(slowmodeWait(sent, 10, sent), 10);
  assert.equal(slowmodeWait(sent, 10, sent + 2_500), 8, "rounds up, so it never says 0 too early");
  assert.equal(slowmodeWait(sent, 10, sent + 10_000), 0);
  assert.equal(slowmodeWait(sent, 10, sent + 60_000), 0);
});

test("a timed-out member is told plainly until when, and what they can still do", () => {
  const now = new Date(2026, 9, 12, 17, 0, 0).getTime();
  const until = new Date(2026, 9, 12, 17, 32, 0).getTime() / 1000;
  const today = timeoutNotice(until, now, "en-US");
  assert.match(today, /^You're timed out until 5:32\s?PM\./);
  assert.match(today, /You can read, but you can't post, react or join voice\./);
  const later = timeoutNotice(new Date(2026, 9, 19, 9, 5, 0).getTime() / 1000, now, "en-US");
  assert.match(later, /until (Mon|Monday), Oct 19, 9:05\s?AM\./, later);
  assert.equal(timeoutNotice(now / 1000 - 1, now, "en-US"), null, "a time out that has run out says nothing");
});

test("the moderation log names each action in plain words", () => {
  assert.equal(describeModAction({ action: "ban_member", metadata: null }), "Banned");
  assert.equal(describeModAction({ action: "unban_member", metadata: null }), "Lifted a ban");
  assert.equal(describeModAction({ action: "kick_member", metadata: null }), "Kicked");
  assert.equal(
    describeModAction({ action: "timeout_member", metadata: JSON.stringify({ seconds: 600 }) }),
    "Timed out for 10 minutes",
  );
  assert.equal(describeModAction({ action: "remove_timeout", metadata: null }), "Lifted a time out");
  assert.equal(
    describeModAction({ action: "set_slowmode", metadata: JSON.stringify({ seconds: 30 }) }),
    "Set slowmode to 30 seconds",
  );
  assert.equal(describeModAction({ action: "set_slowmode", metadata: JSON.stringify({ seconds: 0 }) }), "Turned slowmode off");
  assert.equal(describeModAction({ action: "pause_invites", metadata: null }), "Paused invites");
  assert.equal(describeModAction({ action: "resume_invites", metadata: null }), "Resumed invites");
  assert.equal(describeModAction({ action: "some_new_thing", metadata: null }), "Some new thing");
});

test("the two new permissions exist and have plain labels", () => {
  assert.equal(PERM.MODERATE_MEMBERS, 1 << 9);
  assert.equal(PERM.CREATE_INVITE, 1 << 10);
  const labels = new Map(PERM_LABELS.map((p) => [p.flag, p.label]));
  assert.equal(labels.get(PERM.MODERATE_MEMBERS), "Time out members");
  assert.equal(labels.get(PERM.CREATE_INVITE), "Create invites");
});

test("a message refused by slowmode or a time out says why", () => {
  const refusal = (status: number, message: string) => Object.assign(new Error(message), { status });
  assert.equal(
    moderationRefusal(refusal(429, "slowmode: you can send again in 8s")),
    "slowmode is on here. You can send again in 8s.",
  );
  assert.equal(moderationRefusal(refusal(403, "you're timed out in this space")), "you're timed out in this space.");
  assert.equal(moderationRefusal(refusal(429, "you're sending messages too fast")), null, "the ordinary rate limit isn't slowmode");
  assert.equal(moderationRefusal(refusal(403, "no access to this channel")), null);
  assert.equal(moderationRefusal("nope"), null);
});
