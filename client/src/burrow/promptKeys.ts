import type { KeyboardEvent } from "react";

// Only prompt composers opt in; document editors keep ordinary multiline input.
export function submitPromptOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (event.key !== "Enter" || event.shiftKey || event.altKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  event.preventDefault();
  if (event.repeat || !event.currentTarget.value.trim()) return;
  const button = event.currentTarget.form?.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (button && !button.disabled) event.currentTarget.form?.requestSubmit(button);
}
