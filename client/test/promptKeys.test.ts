import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { KeyboardEvent as ReactKeyEvent } from "react";
import { submitPromptOnEnter } from "../src/burrow/promptKeys.ts";

test("Enter submits prompts, preserving multiline and IME input and disabled states", async () => {
  const window = new Window();
  window.document.body.innerHTML = '<form><textarea required></textarea><button type="button">Other action</button><button type="submit">Send</button></form>';
  const form = window.document.querySelector("form")!;
  const input = form.querySelector("textarea")!;
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const sent: string[] = [];
  form.addEventListener("submit", event => { event.preventDefault(); sent.push(input.value); });
  input.addEventListener("keydown", event => submitPromptOnEnter({
    key: event.key, shiftKey: event.shiftKey, altKey: event.altKey, repeat: event.repeat,
    nativeEvent: event, currentTarget: input, preventDefault: () => event.preventDefault(),
  } as unknown as ReactKeyEvent<HTMLTextAreaElement>));
  const key = (init: Record<string, unknown> = {}) => {
    const event = new window.KeyboardEvent("keydown", { key: "Enter", cancelable: true, ...init });
    input.dispatchEvent(event);
    return event.defaultPrevented;
  };
  try {
    input.value = "First line\nSecond line";
    assert.equal(key({ shiftKey: true }), false);
    assert.equal(key({ isComposing: true }), false);
    assert.equal(key({ keyCode: 229 }), false);
    assert.equal(key({ altKey: true }), false);
    key({ repeat: true });
    submit.disabled = true; key(); submit.disabled = false;
    assert.deepEqual(sent, []);
    key();
    assert.deepEqual(sent, ["First line\nSecond line"]);
    input.value = "   "; key();
    assert.equal(sent.length, 1);
    input.value = "Shortcut still works"; key({ ctrlKey: true });
    assert.deepEqual(sent, ["First line\nSecond line", "Shortcut still works"]);
  } finally { await window.happyDOM.abort(); }
});
