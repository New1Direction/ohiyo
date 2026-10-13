// Time out is offered only on members you may actually time out: never on the owner or
// yourself, and, once the server has said whom you outrank, only on them. The server refuses
// the rest anyway (server/src/api/moderation.rs require_moderator_over).
//   node --experimental-strip-types --test test/moderationRank.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { canActOn } from "../src/lib/moderation.ts";

const base = { ownerId: "owner", currentUserId: "me", allowed: true };

test("without the permission nobody gets the action", () => {
  assert.equal(canActOn("pat", { ...base, allowed: false, moderatable: new Set(["pat"]) }), false);
});

test("never on the owner or on yourself", () => {
  const all = new Set(["owner", "me", "pat"]);
  assert.equal(canActOn("owner", { ...base, moderatable: all }), false);
  assert.equal(canActOn("me", { ...base, moderatable: all }), false);
});

test("a member who ranks as high as you or higher isn't offered", () => {
  const moderatable = new Set(["pat"]);
  assert.equal(canActOn("pat", { ...base, moderatable }), true);
  assert.equal(canActOn("senior-mod", { ...base, moderatable }), false);
});

test("before the server has answered, only the owner and you are left out", () => {
  assert.equal(canActOn("pat", { ...base, moderatable: undefined }), true);
  assert.equal(canActOn("owner", { ...base, moderatable: undefined }), false);
});
