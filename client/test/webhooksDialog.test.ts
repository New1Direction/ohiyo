// The webhooks dialog: the space menu's "Webhooks" for people who manage channels. It lists a
// channel's webhooks by name and never shows a token again; making one (or renewing its URL)
// shows the URL once, with a warning and a Copy button; deleting asks first.
//   node --experimental-strip-types --test test/webhooksDialog.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Hook = { id: string; channel_id: string; name: string; avatar_url: string | null; created_at: number; created_by_name?: string | null };
type Mod = {
  act: (callback: () => void) => void;
  mountWebhooksDialog: (
    el: unknown,
    initial: Hook[],
  ) => { calls: string[]; copied: string[]; closed: () => number; unmount: () => void };
};
type SidebarMod = {
  act: (callback: () => void) => void;
  mountChannelSidebar: (el: unknown, opts: { owner: boolean; manage: boolean; webhooks?: boolean }) => { calls: string[]; unmount: () => void };
};

let bundle: Bundle<Mod>;
let sidebar: Bundle<SidebarMod>;
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
  bundle = await bundleEntry<Mod>(join(fixtures, "mountWebhooksDialog.tsx"), [
    { find: /^\.\/ModalShell$/, replacement: join(fixtures, "modalShellStub.tsx") },
  ]);
  sidebar = await bundleEntry<SidebarMod>(join(fixtures, "mountChannelSidebar.tsx"));
});

after(async () => {
  await bundle?.cleanup();
  await sidebar?.cleanup();
  await window.happyDOM.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const tick = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
};

function open(initial: Hook[] = []) {
  const container = document.createElement("div");
  document.body.append(container);
  const f = bundle.mod.mountWebhooksDialog(container, initial);
  const act = bundle.mod.act;
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text) as unknown as HTMLButtonElement | undefined;
  const field = (label: string) => container.querySelector(`input[aria-label="${label}"]`) as unknown as HTMLInputElement | null;
  const type = (label: string, value: string) =>
    act(() => {
      const input = field(label)!;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    });
  return {
    ...f,
    container,
    text: () => container.textContent ?? "",
    button,
    field,
    type,
    click: (text: string) => act(() => button(text)!.click()),
    clickIn: (rowName: string, text: string) =>
      act(() => {
        const row = [...container.querySelectorAll("li")].find((li) => (li.textContent ?? "").includes(rowName))!;
        const b = [...row.querySelectorAll("button")].find((x) => (x.textContent ?? "").trim() === text)!;
        (b as unknown as HTMLButtonElement).click();
      }),
    done: () => {
      f.unmount();
      container.remove();
    },
  };
}

const existing: Hook[] = [
  { id: "w1", channel_id: "c1", name: "Deploy bot", avatar_url: null, created_at: 1_800_000_000, created_by_name: "Kikka" },
];

test("it lists the channel's webhooks by name and shows no URL until one is made", async () => {
  const f = open(existing);
  try {
    await tick();
    assert.match(f.text(), /Deploy bot/);
    assert.match(f.text(), /Made by Kikka/, "who made it shows");
    assert.equal(f.field("Webhook URL"), null, "no URL is shown for an existing webhook");
    assert.doesNotMatch(f.text(), /secret-/);
    assert.ok(f.calls.includes("list c1"), "the first channel's list loads");
  } finally {
    f.done();
  }
});

test("a webhook's picture loads from the home's file server, like a person's avatar", async () => {
  // The app and its server can be on different addresses (ohiyo.gg and the API), so a stored
  // "/files/…" picture must be fetched from the server, not from the page's own address.
  const f = open([{ ...existing[0], avatar_url: "/files/f1?s=sig" }]);
  try {
    await tick();
    const avatar = f.container.querySelector(".kc-webhooks__avatar") as unknown as HTMLElement;
    assert.ok(avatar, "the row has an avatar");
    assert.match(avatar.style.backgroundImage, /https:\/\/files\.test\/files\/f1\?s=sig/);
    assert.notEqual(avatar.style.backgroundColor, "", "a solid colour sits under the picture");
    assert.equal(avatar.style.backgroundSize, "cover");
  } finally {
    f.done();
  }
});

test("making a webhook shows its URL once, with a warning and Copy", async () => {
  const f = open();
  try {
    await tick();
    f.type("Webhook name", "Release notes");
    f.click("Create webhook");
    await tick();
    assert.deepEqual(f.calls.filter((c) => c.startsWith("create")), ["create c1 Release notes"]);
    assert.equal(f.field("Webhook URL")?.value, "https://ohiyo.test/api/v1/webhooks/w1/secret-1");
    assert.match(f.text(), /won't see it again/i);
    f.click("Copy");
    await tick();
    assert.deepEqual(f.copied, ["https://ohiyo.test/api/v1/webhooks/w1/secret-1"]);
    f.click("Done");
    await tick();
    assert.equal(f.field("Webhook URL"), null, "the URL goes once you're done");
    assert.match(f.text(), /Release notes/, "and the webhook is in the list");
  } finally {
    f.done();
  }
});

test("a new URL replaces the old one and is shown once", async () => {
  const f = open(existing);
  try {
    await tick();
    f.clickIn("Deploy bot", "New URL");
    await tick();
    assert.ok(f.calls.includes("renew w1"));
    assert.equal(f.field("Webhook URL")?.value, "https://ohiyo.test/api/v1/webhooks/w1/secret-1");
    assert.match(f.text(), /old URL stops working/i);
  } finally {
    f.done();
  }
});

test("deleting asks first, then the webhook goes", async () => {
  const f = open(existing);
  try {
    await tick();
    f.clickIn("Deploy bot", "Delete");
    await tick();
    assert.ok(!f.calls.some((c) => c.startsWith("delete")), "nothing is deleted yet");
    assert.match(f.text(), /Messages it posted stay/i);
    f.click("Delete webhook");
    await tick();
    assert.deepEqual(f.calls.filter((c) => c.startsWith("delete")), ["delete w1"]);
    assert.doesNotMatch(f.text(), /Deploy bot/);
  } finally {
    f.done();
  }
});

test("renaming saves the new name", async () => {
  const f = open(existing);
  try {
    await tick();
    f.clickIn("Deploy bot", "Rename");
    f.type("New name for Deploy bot", "Ship it");
    f.click("Save name");
    await tick();
    assert.ok(f.calls.includes("rename w1 Ship it"));
    assert.match(f.text(), /Ship it/);
  } finally {
    f.done();
  }
});

test("the space menu offers Webhooks to people who manage channels, and only to them", () => {
  for (const manage of [true, false]) {
    const container = document.createElement("div");
    document.body.append(container);
    const f = sidebar.mod.mountChannelSidebar(container, { owner: manage, manage, webhooks: true });
    try {
      const name = container.querySelector('button[aria-haspopup="menu"]') as unknown as HTMLButtonElement;
      sidebar.mod.act(() => name.click());
      const items = [...container.querySelectorAll('[role="menuitem"]')].map((el) => (el.textContent ?? "").trim());
      if (manage) {
        assert.ok(items.includes("Webhooks"), `a manager sees Webhooks: ${items.join(", ")}`);
        const item = [...container.querySelectorAll('[role="menuitem"]')].find((el) => (el.textContent ?? "").trim() === "Webhooks");
        sidebar.mod.act(() => (item as unknown as HTMLButtonElement).click());
        assert.ok(f.calls.includes("webhooks"));
      } else {
        assert.ok(!items.includes("Webhooks"), `a member doesn't: ${items.join(", ")}`);
      }
    } finally {
      f.unmount();
      container.remove();
    }
  }
});
