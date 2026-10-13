// The role editor (name, colour, permissions, show separately) and a channel's Permissions
// tab (a private-channel switch, and allow / inherit / deny per role).
//   node --experimental-strip-types --test test/roleEditors.test.ts
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Window } from "happy-dom";
import { bundleEntry, fixtures, type Bundle } from "./fixtures/bundle.ts";

type Mod = {
  act: (callback: () => void) => void;
  mountRoleEditor: (el: unknown, role: unknown, myPermissions: number) => { saved: unknown[]; unmount: () => void };
  mountChannelPermissions: (
    el: unknown,
    overwrites: unknown[],
    roles: unknown[],
  ) => { sets: { target_type: string; target_id: string | null; bits: { allow: number; deny: number } }[]; unmount: () => void };
};

const VIEW = 1 << 6;
const SEND = 1 << 7;
const MANAGE_MESSAGES = 1 << 1;
const ADMIN = 1 << 8;

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
  bundle = await bundleEntry<Mod>(join(fixtures, "mountRoleEditors.tsx"));
});

after(async () => {
  await bundle?.cleanup();
  await window.happyDOM.close();
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const role = { id: "r1", server_id: "s", name: "Helper", color: null, permissions: 0, position: 1, created_at: 0, hoist: false };

function container() {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}
function byLabel(el: ReturnType<typeof container>, label: string) {
  return el.querySelector(`[aria-label="${label}"]`) as unknown as
    | { click(): void; value: string; checked: boolean; disabled: boolean; getAttribute(n: string): string | null; dispatchEvent(e: unknown): boolean }
    | null;
}
function checkbox(el: ReturnType<typeof container>, text: string) {
  const labels = [...el.querySelectorAll("label")].filter((l) => (l.textContent ?? "").includes(text));
  return (labels[0]?.querySelector('input[type="checkbox"]') ?? null) as unknown as { click(): void; checked: boolean; disabled: boolean } | null;
}
function press(target: { click(): void } | null) {
  bundle.mod.act(() => target?.click());
}

test("the role editor shows the role and saves what changed", async () => {
  const el = container();
  const f = bundle.mod.mountRoleEditor(el, role, (1 << 11) - 1);
  try {
    const name = byLabel(el, "Role name");
    assert.equal(name?.value, "Helper");
    assert.ok(byLabel(el, "Custom colour"), "a custom colour box");
    assert.ok(checkbox(el, "Manage messages"), "a checkbox per permission");
    assert.equal(el.textContent?.includes("can do everything"), false, "no warning yet");
    press(checkbox(el, "Administrator"));
    assert.equal(el.textContent?.includes("can do everything"), true, "Administrator warns");
    press(checkbox(el, "Show members separately"));
    const swatch = el.querySelector('button[aria-label^="Colour "]') as unknown as { click(): void } | null;
    press(swatch);
    const save = [...el.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Save changes") as unknown as { click(): void };
    press(save);
    await new Promise((r) => setTimeout(r, 0));
    const patch = f.saved[0] as { name: string; color: string | null; permissions: number; hoist: boolean };
    assert.ok(patch, "saved");
    assert.equal(patch.hoist, true);
    assert.equal((patch.permissions & ADMIN) !== 0, true);
    assert.match(String(patch.color), /^#[0-9a-f]{6}$/i);
  } finally {
    f.unmount();
    el.remove();
  }
});

test("a permission the editor lacks can't be ticked", () => {
  const el = container();
  const f = bundle.mod.mountRoleEditor(el, role, VIEW | SEND | (1 << 4));
  try {
    assert.equal(checkbox(el, "Manage messages")?.disabled, true);
    assert.equal(checkbox(el, "View channels")?.disabled, false);
  } finally {
    f.unmount();
    el.remove();
  }
});

test("the private-channel switch denies View channel to @everyone", async () => {
  const el = container();
  const f = bundle.mod.mountChannelPermissions(el, [], [role]);
  try {
    const sw = byLabel(el, "Private channel");
    assert.equal(sw?.getAttribute("aria-checked"), "false");
    press(sw);
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(f.sets[0], { target_type: "everyone", target_id: null, bits: { allow: 0, deny: VIEW } });
  } finally {
    f.unmount();
    el.remove();
  }
  const el2 = container();
  const g = bundle.mod.mountChannelPermissions(el2, [{ target_type: "everyone", target_id: null, allow: 0, deny: VIEW }], [role]);
  try {
    assert.equal(byLabel(el2, "Private channel")?.getAttribute("aria-checked"), "true");
  } finally {
    g.unmount();
    el2.remove();
  }
});

test("a role's channel permission can be set to deny", async () => {
  const el = container();
  const f = bundle.mod.mountChannelPermissions(el, [{ target_type: "role", target_id: "r1", allow: 0, deny: 0 }], [role]);
  try {
    press(byLabel(el, "Helper · Send messages: Deny"));
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(f.sets.at(-1), { target_type: "role", target_id: "r1", bits: { allow: 0, deny: SEND } });
    void MANAGE_MESSAGES;
  } finally {
    f.unmount();
    el.remove();
  }
});
