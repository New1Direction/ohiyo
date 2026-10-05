// What the app says about updates. Checks it starts by itself stay quiet unless there is
// something to install; a check the person asked for always gets an answer.
//   node --experimental-strip-types --test test/appUpdate.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_INSTALL_FAILED,
  showsUpdateBar,
  updateCheckMessage,
  updateReadyLabel,
  updatesEnabled,
} from "../src/lib/appUpdate.ts";

test("the bar names the version that is ready", () => {
  assert.equal(updateReadyLabel("0.3.1"), "Ohiyo 0.3.1 is ready");
});

test("the app looks for updates every six hours", () => {
  assert.equal(UPDATE_CHECK_INTERVAL_MS, 6 * 60 * 60 * 1000);
});

test("a check the app started says nothing; an available update is announced by the bar", () => {
  assert.equal(updateCheckMessage({ kind: "current" }, false), null);
  assert.equal(updateCheckMessage({ kind: "failed" }, false), null);
  assert.equal(updateCheckMessage({ kind: "available", version: "0.3.1" }, false), null);
});

test("a check the person asked for always answers", () => {
  assert.equal(updateCheckMessage({ kind: "current" }, true), "Ohiyo is up to date.");
  assert.equal(updateCheckMessage({ kind: "failed" }, true), "Couldn't check for updates. Try again later.");
  assert.equal(updateCheckMessage({ kind: "available", version: "0.3.1" }, true), null);
});

test("after Later the bar stays away until the next start, unless the person asks", () => {
  assert.equal(showsUpdateBar(false, false), true);
  assert.equal(showsUpdateBar(false, true), false);
  assert.equal(showsUpdateBar(true, true), true);
});

test("only a build made by the release workflow looks for updates", () => {
  assert.equal(updatesEnabled("1"), true);
  for (const off of [undefined, "", "0", "true", "yes"]) assert.equal(updatesEnabled(off), false, String(off));
});

test("a copy that does not update itself says so when asked, and is silent otherwise", () => {
  assert.equal(updateCheckMessage({ kind: "unavailable" }, true), "This copy of Ohiyo doesn't update itself.");
  assert.equal(updateCheckMessage({ kind: "unavailable" }, false), null);
});

test("a failed install says where to get the new version, not to keep trying", () => {
  // Run from the disk image or the Downloads folder, a Mac app cannot replace itself, ever.
  assert.equal(UPDATE_INSTALL_FAILED, "The update couldn't be installed. Download the new version from ohiyo.gg instead.");
});
