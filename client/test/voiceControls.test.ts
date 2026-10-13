// The rules behind deafen, push to talk, input sensitivity and the call shortcuts.
//   node --experimental-strip-types --test test/voiceControls.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_VOICE_PREFS,
  PTT_IDLE,
  PTT_TAIL_MS,
  VAD_CLOSED,
  VAD_HOLD_MS,
  VOICE_PREFS_KEY,
  callShortcutFor,
  describeKey,
  isTypingTarget,
  levelToDb,
  loadVoicePrefs,
  normalizeVoicePrefs,
  pttKeyApplies,
  pttOpen,
  pttPress,
  pttRelease,
  rmsOf,
  saveVoicePrefs,
  toggleDeafenState,
  toggleMuteState,
  transmitGateOpen,
  vadStep,
} from "../src/lib/voiceControls.ts";

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    data,
  };
}

// ── Deafen ────────────────────────────────────────────────────────────────────

test("deafening mutes the mic too, and undeafening puts the mic back as it was", () => {
  const talking = { muted: false, deafened: false, mutedBeforeDeafen: false };
  const deaf = toggleDeafenState(talking);
  assert.deepEqual({ muted: deaf.muted, deafened: deaf.deafened }, { muted: true, deafened: true });
  assert.deepEqual(toggleDeafenState(deaf), { muted: false, deafened: false, mutedBeforeDeafen: false });

  const quiet = { muted: true, deafened: false, mutedBeforeDeafen: false };
  const deafQuiet = toggleDeafenState(quiet);
  assert.equal(deafQuiet.deafened, true);
  assert.equal(toggleDeafenState(deafQuiet).muted, true, "someone muted before deafening stays muted after");
});

test("unmuting while deafened undeafens too, like Discord", () => {
  const deaf = toggleDeafenState({ muted: false, deafened: false, mutedBeforeDeafen: false });
  assert.deepEqual(toggleMuteState(deaf), { muted: false, deafened: false, mutedBeforeDeafen: false });
  assert.deepEqual(toggleMuteState({ muted: false, deafened: false, mutedBeforeDeafen: false }), {
    muted: true,
    deafened: false,
    mutedBeforeDeafen: false,
  });
});

// ── Push to talk ──────────────────────────────────────────────────────────────

test("push to talk transmits while the key is held and for a short tail after it's let go", () => {
  assert.equal(pttOpen(PTT_IDLE, 0), false, "nothing held: silent");
  const held = pttPress(PTT_IDLE);
  assert.equal(pttOpen(held, 1000), true);
  const released = pttRelease(held, 5000);
  assert.equal(pttOpen(released, 5000), true, "the last word isn't clipped");
  assert.equal(pttOpen(released, 5000 + PTT_TAIL_MS - 1), true);
  assert.equal(pttOpen(released, 5000 + PTT_TAIL_MS), false);
  assert.equal(pttOpen(pttPress(released), 9000), true, "pressing again reopens at once");
});

test("the push to talk key only counts when it isn't being typed into a text field", () => {
  const input = { tagName: "INPUT", type: "text" };
  const textarea = { tagName: "TEXTAREA" };
  const editor = { tagName: "DIV", isContentEditable: true };
  const button = { tagName: "BUTTON" };
  assert.equal(isTypingTarget(input), true);
  assert.equal(isTypingTarget(textarea), true);
  assert.equal(isTypingTarget(editor), true);
  assert.equal(isTypingTarget({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isTypingTarget(button), false);
  assert.equal(isTypingTarget(null), false);

  assert.equal(pttKeyApplies({ code: "KeyV", key: "v" }, "KeyV", button), true);
  assert.equal(pttKeyApplies({ code: "KeyV", key: "v" }, "KeyV", textarea), false, "typing a v isn't talking");
  assert.equal(pttKeyApplies({ code: "F13", key: "F13" }, "F13", textarea), true, "a key that types nothing works anywhere");
  assert.equal(pttKeyApplies({ code: "KeyB", key: "b" }, "KeyV", button), false);
  assert.equal(pttKeyApplies({ code: "KeyV", key: "v" }, null, button), false, "no key set: no push to talk");
});

test("keys are named the way people know them", () => {
  assert.equal(describeKey("KeyV"), "V");
  assert.equal(describeKey("Digit4"), "4");
  assert.equal(describeKey("Space"), "Space");
  assert.equal(describeKey("Backquote"), "`");
  assert.equal(describeKey("ControlLeft"), "Left Ctrl");
  assert.equal(describeKey("AltRight"), "Right Alt");
  assert.equal(describeKey("ShiftLeft"), "Left Shift");
  assert.equal(describeKey("CapsLock"), "Caps Lock");
  assert.equal(describeKey("F13"), "F13");
  assert.equal(describeKey("Mouse4"), "Mouse 4");
  assert.equal(describeKey(null), "");
});

// ── Input sensitivity ─────────────────────────────────────────────────────────

test("the sensitivity gate opens above the threshold, holds briefly, and doesn't chatter", () => {
  const threshold = -40;
  let s = vadStep(VAD_CLOSED, -60, 0, threshold);
  assert.equal(s.open, false, "quiet stays closed");
  s = vadStep(s, -35, 100, threshold);
  assert.equal(s.open, true, "speech opens it");
  s = vadStep(s, -43, 150, threshold);
  assert.equal(s.open, true, "a dip just under the threshold doesn't close it (hysteresis)");
  s = vadStep(s, -70, 200, threshold);
  assert.equal(s.open, true, "silence holds it open for a moment");
  s = vadStep(s, -70, 150 + VAD_HOLD_MS - 1, threshold);
  assert.equal(s.open, true);
  s = vadStep(s, -70, 150 + VAD_HOLD_MS + 1, threshold);
  assert.equal(s.open, false, "then it closes");
  s = vadStep(s, -43, 1000, threshold);
  assert.equal(s.open, false, "reopening needs the full threshold, not the lower closing level");
});

test("levels are measured as RMS in decibels", () => {
  assert.equal(rmsOf([0, 0, 0, 0]), 0);
  assert.ok(Math.abs(rmsOf([1, -1, 1, -1]) - 1) < 1e-9);
  assert.ok(Math.abs(rmsOf([0.5, -0.5]) - 0.5) < 1e-9);
  assert.equal(levelToDb(1), 0);
  assert.ok(Math.abs(levelToDb(0.1) - -20) < 1e-9);
  assert.equal(levelToDb(0), -100, "silence floors at -100 dB, never -Infinity");
  assert.equal(levelToDb(1e-9), -100);
});

test("what decides whether the mic is let through", () => {
  const base = { inputMode: "voice" as const, pttOpen: false, autoSensitivity: true, vadOpen: false };
  assert.equal(transmitGateOpen(base), true, "voice activity with automatic sensitivity: always through");
  assert.equal(transmitGateOpen({ ...base, autoSensitivity: false }), false, "manual sensitivity: only above it");
  assert.equal(transmitGateOpen({ ...base, autoSensitivity: false, vadOpen: true }), true);
  assert.equal(transmitGateOpen({ ...base, inputMode: "ptt" }), false, "push to talk: only while held");
  assert.equal(transmitGateOpen({ ...base, inputMode: "ptt", pttOpen: true }), true);
  assert.equal(transmitGateOpen({ ...base, inputMode: "ptt", pttOpen: true, autoSensitivity: false }), true, "push to talk ignores sensitivity");
});

// ── Shortcuts ─────────────────────────────────────────────────────────────────

test("Ctrl+Shift+M mutes and Ctrl+Shift+D deafens (⌘ on a Mac)", () => {
  const key = (code: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }>) => ({
    key: code.slice(-1).toLowerCase(),
    code,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  });
  assert.equal(callShortcutFor(key("KeyM", { ctrlKey: true, shiftKey: true }), false), "toggle-mute");
  assert.equal(callShortcutFor(key("KeyD", { ctrlKey: true, shiftKey: true }), false), "toggle-deafen");
  assert.equal(callShortcutFor(key("KeyM", { metaKey: true, shiftKey: true }), true), "toggle-mute");
  assert.equal(callShortcutFor(key("KeyD", { metaKey: true, shiftKey: true }), true), "toggle-deafen");
  assert.equal(callShortcutFor(key("KeyM", { ctrlKey: true, shiftKey: true }), true), null, "on a Mac it's ⌘, not Ctrl");
  assert.equal(callShortcutFor(key("KeyM", { ctrlKey: true }), false), null, "Shift is part of it");
  assert.equal(callShortcutFor(key("KeyM", { ctrlKey: true, shiftKey: true, altKey: true }), false), null);
  assert.equal(callShortcutFor(key("KeyK", { ctrlKey: true, shiftKey: true }), false), null);
});

// ── Saved on this device ──────────────────────────────────────────────────────

test("voice settings are saved on this device and read back safely", () => {
  const store = memoryStore();
  assert.deepEqual(loadVoicePrefs(store), DEFAULT_VOICE_PREFS, "nothing saved: the defaults");
  const prefs = { inputMode: "ptt" as const, pttKey: "KeyV", autoSensitivity: false, sensitivityDb: -42 };
  assert.equal(saveVoicePrefs(prefs, store), true);
  assert.ok(store.data.has(VOICE_PREFS_KEY));
  assert.deepEqual(loadVoicePrefs(store), prefs);

  assert.deepEqual(loadVoicePrefs(memoryStore({ [VOICE_PREFS_KEY]: "{not json" })), DEFAULT_VOICE_PREFS);
  const throwing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  };
  assert.deepEqual(loadVoicePrefs(throwing), DEFAULT_VOICE_PREFS, "blocked storage never breaks a call");
  assert.equal(saveVoicePrefs(prefs, throwing), false);
});

test("odd saved values are cleaned up instead of trusted", () => {
  assert.deepEqual(normalizeVoicePrefs(null), DEFAULT_VOICE_PREFS);
  assert.deepEqual(normalizeVoicePrefs("ptt"), DEFAULT_VOICE_PREFS);
  const cleaned = normalizeVoicePrefs({ inputMode: "shout", pttKey: 42, autoSensitivity: "yes", sensitivityDb: 99 });
  assert.equal(cleaned.inputMode, "voice");
  assert.equal(cleaned.pttKey, null);
  assert.equal(cleaned.autoSensitivity, true);
  assert.equal(cleaned.sensitivityDb, 0, "clamped to the loudest setting");
  assert.equal(normalizeVoicePrefs({ sensitivityDb: -500 }).sensitivityDb, -100);
  assert.equal(normalizeVoicePrefs({ sensitivityDb: Number.NaN }).sensitivityDb, DEFAULT_VOICE_PREFS.sensitivityDb);
  assert.equal(normalizeVoicePrefs({ pttKey: "x".repeat(200) }).pttKey, null, "a key code is short");
});
