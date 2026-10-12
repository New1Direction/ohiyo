// What a message does, given your notification settings (Discord-style): whether it pops a
// notification, adds to the number on the Dock icon and tab title, and shows as unread in
// the sidebar. The server's push relay follows the same rules.
//   node --experimental-strip-types --test test/notificationSettings.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MUTE_CHOICES,
  describeMute,
  isMuted,
  messageAlert,
  nextMuteExpiry,
  settingKey,
  settingsFromList,
  unreadFor,
  withSetting,
  type NotificationSetting,
} from "../src/lib/notificationSettings.ts";

const NOW = 1_800_000_000;
const space = (id: string, level: NotificationSetting["level"], muted = false, muted_until: number | null = null): NotificationSetting => ({
  target_type: "server",
  target_id: id,
  level,
  muted,
  muted_until,
});
const chan = (id: string, muted: boolean, muted_until: number | null = null): NotificationSetting => ({
  target_type: "channel",
  target_id: id,
  level: null,
  muted,
  muted_until,
});
const inSpace = { channelId: "c1", serverId: "s1" };
const inDm = { channelId: "dm1", serverId: null };

test("with no settings every message notifies, counts and shows", () => {
  assert.deepEqual(messageAlert({}, inSpace, false, NOW), { notify: true, count: true, show: true });
  assert.deepEqual(messageAlert({}, inDm, false, NOW), { notify: true, count: true, show: true });
});

test("a muted DM is silent, uncounted and not shown as unread", () => {
  const settings = settingsFromList([chan("dm1", true)]);
  assert.deepEqual(messageAlert(settings, inDm, false, NOW), { notify: false, count: false, show: false });
  assert.deepEqual(messageAlert(settings, inDm, true, NOW), { notify: false, count: false, show: false }, "even if it names you");
});

test("a muted channel or space stays quiet unless you're mentioned", () => {
  for (const settings of [settingsFromList([chan("c1", true)]), settingsFromList([space("s1", null, true)])]) {
    assert.deepEqual(messageAlert(settings, inSpace, false, NOW), { notify: false, count: false, show: false });
    assert.deepEqual(messageAlert(settings, inSpace, true, NOW), { notify: true, count: true, show: true }, "a mention gets through");
  }
});

test("only @mentions: plain messages show as unread but don't notify or count", () => {
  const settings = settingsFromList([space("s1", "mentions")]);
  assert.deepEqual(messageAlert(settings, inSpace, false, NOW), { notify: false, count: false, show: true });
  assert.deepEqual(messageAlert(settings, inSpace, true, NOW), { notify: true, count: true, show: true });
});

test("nothing: no notification or count even for a mention; unread still shows unless muted", () => {
  const settings = settingsFromList([space("s1", "nothing")]);
  assert.deepEqual(messageAlert(settings, inSpace, true, NOW), { notify: false, count: false, show: true });
  const mutedToo = settingsFromList([space("s1", "nothing", true)]);
  assert.deepEqual(messageAlert(mutedToo, inSpace, false, NOW), { notify: false, count: false, show: false });
});

test("a mute ends on its own; one with no end lasts until turned off", () => {
  assert.equal(isMuted(chan("c1", true, NOW + 60), NOW), true);
  assert.equal(isMuted(chan("c1", true, NOW - 1), NOW), false, "ended");
  assert.equal(isMuted(chan("c1", true, null), NOW), true, "until turned back on");
  assert.equal(isMuted(chan("c1", false, null), NOW), false);
  assert.equal(isMuted(undefined, NOW), false);
  const ended = settingsFromList([chan("c1", true, NOW - 1)]);
  assert.deepEqual(messageAlert(ended, inSpace, false, NOW), { notify: true, count: true, show: true });
});

test("unread counts split into what the sidebar shows and what the Dock and tab title count", () => {
  const settings = settingsFromList([chan("muted", true), space("quiet", "mentions")]);
  const serverOf = (id: string) => ({ muted: "loud", plain: "loud", calm: "quiet", called: "quiet" })[id] ?? null;
  const unread = { muted: 4, plain: 2, calm: 3, called: 1, dm: 5 };
  const { shown, counted } = unreadFor(unread, new Set(["called"]), settings, serverOf, NOW);
  assert.deepEqual(shown, { plain: 2, calm: 3, called: 1, dm: 5 }, "muted chats show no unread number");
  assert.deepEqual(counted, { plain: 2, called: 1, dm: 5 }, "only chats that may notify add to the badge");
});

test("settings are kept by target, and going back to the defaults drops one", () => {
  let settings = settingsFromList([space("s1", "mentions")]);
  assert.equal(settings[settingKey("server", "s1")]?.level, "mentions");
  settings = withSetting(settings, chan("c1", true));
  assert.equal(Object.keys(settings).length, 2);
  const before = settings;
  settings = withSetting(settings, space("s1", "all", false));
  assert.equal(settings[settingKey("server", "s1")], undefined, "the default isn't kept");
  assert.equal(before[settingKey("server", "s1")]?.level, "mentions", "the old map is untouched");
});

test("mute choices match Discord's", () => {
  assert.deepEqual(
    MUTE_CHOICES.map((c) => c.seconds),
    [15 * 60, 60 * 60, 8 * 60 * 60, 24 * 60 * 60, null],
  );
  assert.equal(MUTE_CHOICES.at(-1)?.label, "Until I turn it back on");
});

test("a mute is described in plain words", () => {
  assert.equal(describeMute(chan("c1", false), NOW), null);
  assert.equal(describeMute(chan("c1", true, null), NOW), "Muted until you turn it back on");
  assert.match(describeMute(chan("c1", true, NOW + 3600), NOW) ?? "", /^Muted until /);
  assert.equal(describeMute(chan("c1", true, NOW - 1), NOW), null, "an ended mute isn't described");
});

test("the soonest mute to end is found, so the app can refresh then", () => {
  const settings = settingsFromList([chan("a", true, NOW + 900), chan("b", true, NOW + 60), chan("c", true, null), chan("d", true, NOW - 5)]);
  assert.equal(nextMuteExpiry(settings, NOW), NOW + 60);
  assert.equal(nextMuteExpiry({}, NOW), null);
});
