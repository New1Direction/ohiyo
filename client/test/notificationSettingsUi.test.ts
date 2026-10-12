// Notification settings on screen: the dialog a space, channel or DM opens to choose what
// notifies you and to mute it; the "Notification settings" entry in the space menu; and a
// muted channel looking muted in the sidebar, with no unread number.
//   node --experimental-strip-types --test test/notificationSettingsUi.test.ts

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type SaveCall = { level?: string | null; muted: boolean; mute_seconds?: number | null };
type Target = { type: "server" | "channel"; id: string; name: string; kind: "space" | "channel" | "dm" };
type Setting = { target_type: "server" | "channel"; target_id: string; level: string | null; muted: boolean; muted_until: number | null };
type DialogMod = {
  act: (callback: () => void) => void;
  mountNotificationSettings: (el: unknown, target: Target, setting: Setting | undefined, now: number) => { saves: SaveCall[]; closed: () => number; unmount: () => void };
};
type SidebarMod = {
  act: (callback: () => void) => void;
  mountChannelSidebar: (
    el: unknown,
    opts: { owner: boolean; manage: boolean; notificationSettings?: boolean; mutedChannelIds?: string[]; unread?: Record<string, number> },
  ) => { calls: string[]; unmount: () => void };
};

const NOW = 1_800_000_000;
let dialog: Bundle<DialogMod>;
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
  dialog = await bundleEntry<DialogMod>(join(fixtures, "mountNotificationSettings.tsx"), [
    { find: /^\.\/ModalShell$/, replacement: join(fixtures, "modalShellStub.tsx") },
  ]);
  sidebar = await bundleEntry<SidebarMod>(join(fixtures, "mountChannelSidebar.tsx"));
});

after(async () => {
  await dialog?.cleanup();
  await sidebar?.cleanup();
  await window.happyDOM.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function openDialog(target: Target, setting?: Setting) {
  const container = document.createElement("div");
  document.body.append(container);
  const f = dialog.mod.mountNotificationSettings(container, target, setting, NOW);
  const act = dialog.mod.act;
  const radio = (label: string) =>
    [...container.querySelectorAll('input[type="radio"]')].find(
      (r) => (r.closest("label")?.textContent ?? "").trim().startsWith(label),
    ) as unknown as HTMLInputElement | undefined;
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text) as unknown as HTMLButtonElement | undefined;
  return {
    ...f,
    container,
    text: () => container.textContent ?? "",
    // Each choice's name, without the hint under it.
    radios: () =>
      [...container.querySelectorAll('input[type="radio"]')].map((r) => (r.closest("label")?.querySelector(".kc-notif-option__name")?.textContent ?? "").trim()),
    radio,
    pick: (label: string) => act(() => radio(label)!.click()),
    muteFor: (label: string) =>
      act(() => {
        const select = container.querySelector('select[aria-label="Mute"]') as unknown as HTMLSelectElement;
        const option = [...select.options].find((o) => o.textContent === label)!;
        select.value = option.value;
        select.dispatchEvent(new window.Event("change", { bubbles: true }) as unknown as Event);
      }),
    click: (text: string) => act(() => button(text)!.click()),
    button,
    done: () => {
      f.unmount();
      container.remove();
    },
  };
}

test("a space offers all messages, only @mentions or nothing, and a mute", async () => {
  const f = openDialog({ type: "server", id: "s1", name: "Gate HQ", kind: "space" });
  try {
    assert.match(f.text(), /Gate HQ/);
    assert.deepEqual(f.radios(), ["All messages", "Only @mentions", "Nothing"]);
    assert.equal(f.radio("All messages")?.checked, true, "all messages is the default");
    f.pick("Only @mentions");
    f.muteFor("For 1 hour");
    f.click("Save");
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(f.saves, [{ level: "mentions", muted: true, mute_seconds: 3600 }]);
    assert.equal(f.closed(), 1, "saving closes the dialog");
  } finally {
    f.done();
  }
});

test("a channel or DM can be muted but has no level of its own", async () => {
  for (const kind of ["channel", "dm"] as const) {
    const f = openDialog({ type: "channel", id: "c1", name: kind === "dm" ? "Sam" : "general", kind });
    try {
      assert.deepEqual(f.radios(), [], `a ${kind} has no level choices`);
      f.muteFor("Until I turn it back on");
      f.click("Save");
      await new Promise((r) => setTimeout(r, 0));
      assert.deepEqual(f.saves, [{ muted: true, mute_seconds: null }]);
    } finally {
      f.done();
    }
  }
});

test("a muted chat says until when, and Unmute turns it back on", async () => {
  const f = openDialog(
    { type: "server", id: "s1", name: "Gate HQ", kind: "space" },
    { target_type: "server", target_id: "s1", level: "nothing", muted: true, muted_until: null },
  );
  try {
    assert.match(f.text(), /Muted until you turn it back on/);
    assert.equal(f.radio("Nothing")?.checked, true, "the saved level is shown");
    f.click("Unmute");
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(f.saves, [{ level: "nothing", muted: false }]);
  } finally {
    f.done();
  }
});

test("the space menu offers Notification settings", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const f = sidebar.mod.mountChannelSidebar(container, { owner: false, manage: false, notificationSettings: true });
  try {
    sidebar.mod.act(() => (container.querySelector('button[aria-haspopup="menu"]') as unknown as HTMLButtonElement).click());
    const item = [...container.querySelectorAll('[role="menuitem"]')].find((el) => (el.textContent ?? "").trim() === "Notification settings");
    assert.ok(item, "Notification settings is in the space menu");
    sidebar.mod.act(() => (item as unknown as HTMLButtonElement).click());
    assert.deepEqual(f.calls, ["notification settings"]);
  } finally {
    f.unmount();
    container.remove();
  }
});

test("a muted channel looks muted and shows no unread number", () => {
  const container = document.createElement("div");
  document.body.append(container);
  const f = sidebar.mod.mountChannelSidebar(container, { owner: false, manage: false, mutedChannelIds: ["c3"], unread: { c3: 4 } });
  try {
    const row = [...container.querySelectorAll(".kc-channel-row")].find((el) => (el.textContent ?? "").includes("random"));
    assert.ok(row, "the muted channel is still listed");
    assert.ok(row!.querySelector('[aria-label="Muted"]'), "it says it's muted");
    assert.equal(row!.querySelector('[aria-label$="unread"]'), null, "no unread number on a muted channel");
  } finally {
    f.unmount();
    container.remove();
  }
});
