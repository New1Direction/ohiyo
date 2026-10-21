import type { BurrowAgent, BurrowTask } from "../api";
import { apiStatus } from "../lib/apiErrors";

export function followUpLabel(phase: string): string {
  switch (phase) {
    case "queued": return "Waiting to send";
    case "dispatching": return "Sending to Kikka…";
    case "sent": return "Sent to Kikka";
    case "review": return "Delivery needs checking";
    case "discarded": return "Not sent";
    default: return "Status unavailable";
  }
}

// Older saved runs also contain technical messages. Translate at the display
// boundary without rewriting history, permissions, or recovery decisions.
export function taskActivity(task: BurrowTask, view: BurrowAgent | null): string {
  const text = task.error || view?.agent.activity || "";
  if (task.state === "failed" && task.error?.startsWith("Stopped")) return "Stopped. Your saved work is still here. Any costs already incurred still apply.";
  if (/20-request.*limit/i.test(text)) return "Kikka reached this task’s 20-request limit and paused. Follow-ups and summaries count too. Your saved work is still here.";
  if (/budget.*exhausted|campaign.*limit/i.test(text)) return "Kikka has reached the approved work limit and paused. Your saved work is still here.";
  if (/schema|literal evidence|answer could not be read|without a finished result/i.test(text)) return "Kikka couldn’t check the new result, so it hasn’t replaced your saved work.";
  if (/request.*(interrupted|unknown outcome)|acknowledgement|request identity|confirm.*(started|interrupted work)/i.test(text)) return "Kikka lost confirmation of the last request and has paused. It won’t repeat it automatically; it may already have cost money.";
  if (/instruction.*(interrupted|confirm)|confirm.*instruction/i.test(text)) return "Kikka couldn’t confirm whether your instruction arrived. It won’t send it again automatically.";
  if (/connection|free route|unapproved model|spending policy|price\/output|privacy confirmation/i.test(text)) return "The approved connection can’t be used right now. Kikka has paused without switching to another service.";
  if (!view) return "Your request is saved. Check the task’s connection and permissions before starting.";
  if (task.state === "waiting" || task.state === "failed") return "Kikka couldn’t continue. Your saved work is still here. Check the task before starting anything else.";
  if (text.startsWith("Reading https://")) {
    try { return `Reading ${new URL(text.slice(8).replace(/…$/, "")).hostname}…`; } catch { /* Use the task state when an old activity cannot be read. */ }
  }
  if (text === "Reading and comparing the saved information…") return "Comparing the information collected so far…";
  if (/instruction.*queued/.test(text)) return "Your instruction is waiting. Kikka will use it when the current step finishes.";
  return task.state === "draft_ready" ? "Your saved result is ready. You can ask for a change without losing this version." : "Kikka is working on your request…";
}

export function taskActionError(error: unknown, fallback: string): string {
  switch (apiStatus(error)) {
    case 401: return "Please sign in again before continuing.";
    case 403: return "You don’t have permission to do that here. Check your account and allowed actions.";
    case 404: return "This saved item is no longer available to your account.";
    case 409: return "This task or saved choice has changed. Refresh it before trying again.";
    case 429: return "Too many requests right now. Wait a little before trying again.";
    default: return fallback;
  }
}
