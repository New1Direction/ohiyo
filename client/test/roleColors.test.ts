// The rules behind coloured names, the member list's role groups, role reordering and a
// channel's own permissions (allow / inherit / deny per permission).
//   node --experimental-strip-types --test test/roleColors.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contrastRatio,
  hoistGroups,
  isPrivateChannel,
  isValidRoleColor,
  moveRole,
  nameColors,
  overwriteState,
  withOverwriteState,
} from "../src/lib/roleColors.ts";

const VIEW = 1 << 6;
const SEND = 1 << 7;

const role = (id: string, position: number, color: string | null, hoist = false) => ({
  id,
  server_id: "s",
  name: id.toUpperCase(),
  color,
  permissions: 0,
  position,
  created_at: 0,
  hoist,
});

const space = {
  roles: [role("low", 1, "#ff0000"), role("mid", 2, null, true), role("top", 3, "#00aa00", true)],
  member_roles: [
    { user_id: "ann", role_id: "low" },
    { user_id: "ann", role_id: "mid" },
    { user_id: "bob", role_id: "top" },
    { user_id: "bob", role_id: "low" },
    { user_id: "cy", role_id: "mid" },
  ],
};

test("a name takes the colour of the highest role that has one", () => {
  const colors = nameColors(space);
  assert.equal(colors.get("bob"), "#00aa00", "top beats low");
  assert.equal(colors.get("ann"), "#ff0000", "an uncoloured higher role doesn't hide a coloured lower one");
  assert.equal(colors.has("cy"), false, "only uncoloured roles: the default colour");
  assert.equal(colors.has("dee"), false, "no roles");
});

test("members are grouped under their highest shown-separately role, then online and offline", () => {
  const members = ["ann", "bob", "cy", "dee", "eve"].map((id) => ({ id, display_name: id }));
  const groups = hoistGroups(members, space, new Set(["ann", "dee"]));
  assert.deepEqual(
    groups.map((g) => [g.label, g.members.map((m) => m.id)]),
    [
      ["TOP", ["bob"]],
      ["MID", ["ann", "cy"]],
      ["Online", ["dee"]],
      ["Offline", ["eve"]],
    ],
  );
});

test("a role colour is #rrggbb, and contrast is measured the WCAG way", () => {
  assert.equal(isValidRoleColor("#3fa7ff"), true);
  assert.equal(isValidRoleColor("#3FA7FF"), true);
  for (const bad of ["red", "#fff", "#12345g", "3fa7ff", ""]) assert.equal(isValidRoleColor(bad), false, bad);
  assert.equal(Math.round(contrastRatio("#ffffff", "#000000")), 21);
  assert.equal(contrastRatio("#777777", "#777777"), 1);
});

test("moving a role swaps it with its neighbour and stops at the ends", () => {
  const order = ["a", "b", "c"];
  assert.deepEqual(moveRole(order, "b", "up"), ["b", "a", "c"]);
  assert.deepEqual(moveRole(order, "b", "down"), ["a", "c", "b"]);
  assert.deepEqual(moveRole(order, "a", "up"), order);
  assert.deepEqual(moveRole(order, "c", "down"), order);
  assert.deepEqual(order, ["a", "b", "c"], "the input isn't changed");
});

test("a permission on a channel is allowed, denied or left to the role", () => {
  const ow = { allow: VIEW, deny: SEND };
  assert.equal(overwriteState(ow, VIEW), "allow");
  assert.equal(overwriteState(ow, SEND), "deny");
  assert.equal(overwriteState(ow, 1 << 1), "inherit");
  assert.deepEqual(withOverwriteState(ow, SEND, "allow"), { allow: VIEW | SEND, deny: 0 });
  assert.deepEqual(withOverwriteState(ow, VIEW, "inherit"), { allow: 0, deny: SEND });
  assert.deepEqual(ow, { allow: VIEW, deny: SEND }, "the input isn't changed");
});

test("a channel is private when @everyone is denied View channel", () => {
  assert.equal(isPrivateChannel([{ target_type: "everyone", target_id: null, allow: 0, deny: VIEW }]), true);
  assert.equal(isPrivateChannel([{ target_type: "everyone", target_id: null, allow: 0, deny: SEND }]), false);
  assert.equal(isPrivateChannel([{ target_type: "role", target_id: "x", allow: 0, deny: VIEW }]), false);
  assert.equal(isPrivateChannel([]), false);
});
