// The moderation dialogs: time a member out, ban with an option to wipe their recent
// messages, the ban list with Unban, invite management (pause, who may invite, revoke), the
// moderation log with names and a filter, slowmode, and what the composer says to someone
// timed out or slowed down.
//   node --experimental-strip-types --test test/moderationDialogs.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Ban = { user: { id: string; username: string; display_name: string; avatar_url: string | null }; banned_by_name: string | null; reason: string | null; banned_at: number };
type Invite = { code: string; created_by: string | null; created_by_name: string | null; uses: number; max_uses: number | null; expires_at: number | null; created_at: number };
type Entry = { id: string; action: string; actor_name: string | null; target_name: string | null; target_type: string; target_id: string; reason: string | null; metadata: string | null; created_at: number };
type Mod = {
  act: (callback: () => void) => void;
  mountTimeoutDialog: (el: unknown) => { confirmed: string[]; closed: () => number; unmount: () => void };
  mountBanDialog: (el: unknown) => { confirmed: string[]; unmount: () => void };
  mountBansDialog: (el: unknown, initial: Ban[]) => { calls: string[]; unmount: () => void };
  mountInvitesDialog: (el: unknown, initial: Invite[], canManageServer: boolean, now: number) => { calls: string[]; unmount: () => void };
  mountModerationLog: (el: unknown, pages: Entry[][]) => { calls: string[]; unmount: () => void };
  mountComposerNotice: (
    el: unknown,
    props: { timedOutUntil: number | null; slowmodeSeconds: number; lastSentAt: number | null; now: number },
  ) => { unmount: () => void };
  mountSlowmodeDialog: (el: unknown, seconds: number) => { saved: number[]; unmount: () => void };
};

let bundle: Bundle<Mod>;
const window = new Window({ url: "http://localhost" });
const document = window.document;
const originals = new Map<string, PropertyDescriptor | undefined>();

before(async () => {
  const globals = {
    window,
    document,
    navigator: window.navigator,
    location: window.location,
    localStorage: window.localStorage,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  bundle = await bundleEntry<Mod>(join(fixtures, "mountModeration.tsx"), [
    { find: /^\.\.\/ModalShell$/, replacement: join(fixtures, "modalShellStub.tsx") },
  ]);
});

after(async () => {
  await bundle?.cleanup();
  await window.happyDOM.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const tick = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function host() {
  const container = document.createElement("div");
  document.body.append(container);
  const act = bundle.mod.act;
  const buttons = () => [...container.querySelectorAll("button")] as unknown as HTMLButtonElement[];
  const button = (text: string) => buttons().find((b) => (b.textContent ?? "").trim() === text);
  const byLabel = (label: string) => container.querySelector(`[aria-label="${label}"]`) as unknown as HTMLElement | null;
  const setValue = (el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string, event = "input") =>
    act(() => {
      const proto = el.tagName === "SELECT" ? window.HTMLSelectElement.prototype : el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
      el.dispatchEvent(new window.Event(event, { bubbles: true }) as unknown as Event);
    });
  return {
    container,
    act,
    text: () => container.textContent ?? "",
    button,
    byLabel,
    setValue,
    click: (el: HTMLElement | undefined | null) => act(() => (el as HTMLElement).click()),
    remove: () => container.remove(),
  };
}

test("time out: six lengths to choose from, an optional reason, and the choice is sent", () => {
  const h = host();
  const f = bundle.mod.mountTimeoutDialog(h.container);
  try {
    assert.match(h.text(), /Time out Spammer/);
    const radios = [...h.container.querySelectorAll('input[type="radio"]')] as unknown as HTMLInputElement[];
    const labels = radios.map((r) => (r.closest("label")?.textContent ?? "").trim());
    assert.deepEqual(labels, ["60 seconds", "5 minutes", "10 minutes", "1 hour", "1 day", "1 week"]);
    h.click(radios[3]);
    h.setValue(h.byLabel("Reason (optional)") as HTMLTextAreaElement, "flooding");
    h.click(h.button("Time out"));
    assert.deepEqual(f.confirmed, ["3600 flooding"]);
  } finally {
    f.unmount();
    h.remove();
  }
});

test("ban: chooses whether to wipe their recent messages, none by default", () => {
  const h = host();
  const f = bundle.mod.mountBanDialog(h.container);
  try {
    assert.match(h.text(), /Ban Spammer/);
    const select = h.byLabel("Delete their messages") as HTMLSelectElement;
    const options = [...select.querySelectorAll("option")].map((o) => (o.textContent ?? "").trim());
    assert.deepEqual(options, ["Don't delete any", "From the last hour", "From the last 24 hours", "From the last 7 days"]);
    assert.equal(select.value, "0");
    h.setValue(select, "86400", "change");
    h.setValue(h.byLabel("Reason (optional)") as HTMLInputElement, "spam links");
    h.click(h.button("Ban"));
    assert.deepEqual(f.confirmed, ["86400 spam links"]);
  } finally {
    f.unmount();
    h.remove();
  }
});

test("the ban list says who banned whom and why, and Unban takes them off it", async () => {
  const h = host();
  const f = bundle.mod.mountBansDialog(h.container, [
    { user: { id: "u1", username: "spammer", display_name: "Spammer", avatar_url: null }, banned_by_name: "Kikka", reason: "links", banned_at: 1_800_000_000 },
  ]);
  try {
    await tick();
    assert.match(h.text(), /Spammer/);
    assert.match(h.text(), /@spammer/);
    assert.match(h.text(), /Banned by Kikka/);
    assert.match(h.text(), /links/);
    h.click(h.byLabel("Unban Spammer"));
    await tick();
    assert.ok(f.calls.includes("unban u1"));
    assert.match(h.text(), /Nobody is banned/);
  } finally {
    f.unmount();
    h.remove();
  }
});

test("invites: the space's managers pause invites and decide who may make them; links can be revoked", async () => {
  const now = Date.UTC(2026, 9, 12, 12, 0, 0);
  const h = host();
  const f = bundle.mod.mountInvitesDialog(
    h.container,
    [{ code: "abc123", created_by: "u2", created_by_name: "Bea", uses: 3, max_uses: 10, expires_at: now / 1000 + 86400, created_at: 1 }],
    true,
    now,
  );
  try {
    await tick();
    assert.match(h.text(), /abc123/);
    assert.match(h.text(), /Bea/);
    assert.match(h.text(), /Expires in 1 day · 7 uses left/);
    const pause = h.byLabel("Pause invites") as HTMLInputElement;
    assert.equal(pause.getAttribute("aria-checked") ?? String(pause.checked), "false");
    h.click(pause);
    await tick();
    assert.ok(f.calls.includes('update {"paused":true}'), f.calls.join(" | "));
    h.click(h.byLabel("Members can create invites"));
    await tick();
    assert.ok(f.calls.includes('update {"members_can_invite":false}'), f.calls.join(" | "));
    h.click(h.byLabel("Revoke invite abc123"));
    await tick();
    assert.ok(f.calls.includes("revoke abc123"));
    assert.doesNotMatch(h.text(), /abc123/);
  } finally {
    f.unmount();
    h.remove();
  }
});

test("invites: a member without Manage Server sees their own links but no space switches", async () => {
  const h = host();
  const f = bundle.mod.mountInvitesDialog(
    h.container,
    [{ code: "mine01", created_by: "me", created_by_name: "Me", uses: 0, max_uses: null, expires_at: null, created_at: 1 }],
    false,
    Date.UTC(2026, 9, 12),
  );
  try {
    await tick();
    assert.match(h.text(), /mine01/);
    assert.equal(h.byLabel("Pause invites"), null);
    assert.equal(h.byLabel("Members can create invites"), null);
  } finally {
    f.unmount();
    h.remove();
  }
});

test("the moderation log names people, says why, filters by action and loads more", async () => {
  const at = Math.floor(Date.UTC(2026, 9, 12, 12) / 1000);
  const entry = (id: string, action: string, actor: string | null, target: string, reason: string | null, metadata: string | null = null): Entry => ({
    id, action, actor_name: actor, target_name: target, target_type: "user", target_id: `t-${id}`, reason, metadata, created_at: at,
  });
  const h = host();
  const f = bundle.mod.mountModerationLog(h.container, [
    [entry("1", "timeout_member", "Kikka", "Spammer", "flooding", JSON.stringify({ seconds: 600 })), entry("2", "kick_member", null, "Troll", null)],
    [entry("3", "ban_member", "Kikka", "Bot", "spam")],
  ]);
  try {
    await tick();
    assert.match(h.text(), /Kikka/);
    assert.match(h.text(), /Timed out for 10 minutes/);
    assert.match(h.text(), /Spammer/);
    assert.match(h.text(), /flooding/);
    assert.match(h.text(), /Deleted account/, "an actor who deleted their account");
    assert.doesNotMatch(h.text(), /t-1/, "no raw ids");
    h.click(h.button("Load more"));
    await tick();
    assert.match(h.text(), /Banned/);
    assert.ok(f.calls.some((c) => c.startsWith("list all ") && !c.endsWith("-")), f.calls.join(" | "));
    h.setValue(h.byLabel("Filter actions") as HTMLSelectElement, "kick_member", "change");
    await tick();
    assert.ok(f.calls.includes("list kick_member -"), f.calls.join(" | "));
    assert.doesNotMatch(h.text(), /Timed out for 10 minutes/);
  } finally {
    f.unmount();
    h.remove();
  }
});

test("the composer tells a timed-out member until when, instead of letting them type", () => {
  const now = new Date(2026, 9, 12, 17, 0, 0).getTime();
  const h = host();
  const f = bundle.mod.mountComposerNotice(h.container, {
    timedOutUntil: new Date(2026, 9, 12, 17, 32, 0).getTime() / 1000,
    slowmodeSeconds: 0,
    lastSentAt: null,
    now,
  });
  try {
    const status = h.container.querySelector('[role="status"]');
    assert.ok(status, "announced");
    assert.match(h.text(), /You're timed out until 5:32\s?PM/);
  } finally {
    f.unmount();
    h.remove();
  }
});

test("the composer counts down in slowmode and says so", () => {
  const now = 1_000_000;
  const h = host();
  const f = bundle.mod.mountComposerNotice(h.container, { timedOutUntil: null, slowmodeSeconds: 10, lastSentAt: now - 2_500, now });
  try {
    assert.match(h.text(), /Slowmode is on: one message every 10 seconds/);
    assert.match(h.text(), /You can post again in 8s/);
  } finally {
    f.unmount();
    h.remove();
  }
  const idle = host();
  const g = bundle.mod.mountComposerNotice(idle.container, { timedOutUntil: null, slowmodeSeconds: 0, lastSentAt: null, now });
  try {
    assert.equal(idle.text().trim(), "", "nothing to say without slowmode or a time out");
  } finally {
    g.unmount();
    idle.remove();
  }
});

test("slowmode: the picker offers off and seven lengths and saves the choice", () => {
  const h = host();
  const f = bundle.mod.mountSlowmodeDialog(h.container, 0);
  try {
    const select = h.byLabel("Slowmode") as HTMLSelectElement;
    const options = [...select.querySelectorAll("option")].map((o) => (o.textContent ?? "").trim());
    assert.deepEqual(options, ["Off", "5 seconds", "10 seconds", "30 seconds", "1 minute", "5 minutes", "15 minutes", "1 hour"]);
    h.setValue(select, "30", "change");
    h.click(h.button("Save"));
    assert.deepEqual(f.saved, [30]);
  } finally {
    f.unmount();
    h.remove();
  }
});
