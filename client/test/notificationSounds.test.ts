// Notification sounds. The old "Message sound" plugin ticked on every message — your own,
// muted chats, busy spaces. A sound now follows the same rules as a notification, and by
// default only DMs and @mentions make one; it never plays for what you sent, for someone you
// blocked, or for the chat you're looking at.
//   node --experimental-strip-types --test test/notificationSounds.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SOUND_PREFS,
  loadSoundPrefs,
  saveSoundPrefs,
  shouldPlaySound,
  SOUNDS,
  type SoundDecision,
  type SoundPrefs,
} from "../src/lib/notificationSounds.ts";

const base: SoundDecision = {
  fromMe: false,
  blocked: false,
  notifyAllowed: true,
  lookingAtIt: false,
  isDirect: false,
  mentioned: false,
};
const prefs = (over: Partial<SoundPrefs> = {}): SoundPrefs => ({ ...DEFAULT_SOUND_PREFS, ...over });

test("by default a DM or an @mention makes a sound, and a plain message in a space doesn't", () => {
  assert.equal(shouldPlaySound({ ...base, isDirect: true }, prefs()), true);
  assert.equal(shouldPlaySound({ ...base, mentioned: true }, prefs()), true);
  assert.equal(shouldPlaySound(base, prefs()), false);
});

test("'all messages I'd be notified about' also sounds for a plain message the rules let through", () => {
  assert.equal(shouldPlaySound(base, prefs({ mode: "all" })), true);
});

test("never for your own message, a blocked person, the chat you're looking at, or a muted chat", () => {
  const loud = prefs({ mode: "all" });
  assert.equal(shouldPlaySound({ ...base, isDirect: true, fromMe: true }, loud), false);
  assert.equal(shouldPlaySound({ ...base, isDirect: true, blocked: true }, loud), false);
  assert.equal(shouldPlaySound({ ...base, isDirect: true, lookingAtIt: true }, loud), false);
  assert.equal(shouldPlaySound({ ...base, isDirect: true, notifyAllowed: false }, loud), false);
  assert.equal(shouldPlaySound({ ...base, mentioned: true, notifyAllowed: false }, loud), false);
});

test("sounds can be switched off entirely", () => {
  assert.equal(shouldPlaySound({ ...base, isDirect: true }, prefs({ enabled: false })), false);
});

test("there are a few short sounds to choose from, and the default is one of them", () => {
  assert.ok(SOUNDS.length >= 4 && SOUNDS.length <= 6, "four to six sounds");
  assert.equal(new Set(SOUNDS.map((s) => s.id)).size, SOUNDS.length, "ids are unique");
  assert.ok(SOUNDS.every((s) => s.label.length > 0));
  assert.ok(SOUNDS.some((s) => s.id === DEFAULT_SOUND_PREFS.sound));
  assert.equal(DEFAULT_SOUND_PREFS.enabled, true);
  assert.equal(DEFAULT_SOUND_PREFS.mode, "dms-mentions");
});

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

test("preferences are kept on this device, and anything odd falls back to the defaults", () => {
  const storage = memoryStorage();
  assert.deepEqual(loadSoundPrefs(storage), DEFAULT_SOUND_PREFS);
  const mine = prefs({ enabled: false, sound: SOUNDS[SOUNDS.length - 1].id, volume: 0.25, mode: "all" });
  saveSoundPrefs(mine, storage);
  assert.deepEqual(loadSoundPrefs(storage), mine);

  const broken = memoryStorage({ "ohiyo.soundPrefs.v1": "{not json" });
  assert.deepEqual(loadSoundPrefs(broken), DEFAULT_SOUND_PREFS);
  const odd = memoryStorage({
    "ohiyo.soundPrefs.v1": JSON.stringify({ enabled: "yes", sound: "airhorn", volume: 7, mode: "everything" }),
  });
  assert.deepEqual(loadSoundPrefs(odd), DEFAULT_SOUND_PREFS);
  const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.deepEqual(loadSoundPrefs(throwing), DEFAULT_SOUND_PREFS);
  assert.doesNotThrow(() => saveSoundPrefs(mine, throwing));
});
