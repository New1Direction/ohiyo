// The ring of an incoming DM call follows Settings → Notifications: sound off rings silently,
// and the volume slider makes it louder or softer. At the default volume it rings as before.
//   node --experimental-strip-types --test test/ringtone.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SOUND_PREFS, type SoundPrefs } from "../src/lib/notificationSounds.ts";
import { ringVolume } from "../src/lib/ringtone.ts";

const prefs = (over: Partial<SoundPrefs>): SoundPrefs => ({ ...DEFAULT_SOUND_PREFS, ...over });

test("at the default volume the ring is as loud as it always was", () => {
  assert.equal(ringVolume(DEFAULT_SOUND_PREFS), 0.18);
});

test("with sounds turned off the call rings silently", () => {
  assert.equal(ringVolume(prefs({ enabled: false })), null);
});

test("the volume slider scales the ring", () => {
  const quiet = ringVolume(prefs({ volume: 0.2 }));
  const loud = ringVolume(prefs({ volume: 1 }));
  assert.ok(quiet !== null && loud !== null);
  assert.ok(quiet < 0.18 && loud > 0.18, `${quiet} < 0.18 < ${loud}`);
  assert.equal(loud, 0.3);
});

test("the slider at zero is silence, not a whisper", () => {
  assert.equal(ringVolume(prefs({ volume: 0 })), null);
});

test("a volume outside 0..1 is held to the ends", () => {
  assert.equal(ringVolume(prefs({ volume: 7 })), 0.3);
  assert.equal(ringVolume(prefs({ volume: -1 })), null);
});
