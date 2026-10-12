// "Not me" on the new-device alert: take the devices off the account, then end every
// session. The alert used to forget the devices before signing everyone out, so if that
// failed the alert was gone, the stolen session still worked, and there was no retry.
//   node --experimental-strip-types --test test/notMe.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import { notMe } from "../src/lib/notMe.ts";

function steps(failAt?: "remove" | "sessions") {
  const done: string[] = [];
  return {
    done,
    deps: {
      removeDevice: async (id: number) => {
        if (failAt === "remove") throw new Error("offline");
        done.push(`remove ${id}`);
      },
      endAllSessions: async () => {
        if (failAt === "sessions") throw new Error("offline");
        done.push("end sessions");
      },
      forget: (ids: readonly number[]) => {
        done.push(`forget ${ids.join(",")}`);
      },
    },
  };
}

test("the devices go, every session ends, and only then are they forgotten", async () => {
  const s = steps();
  await notMe([7, 9], s.deps);
  assert.deepEqual(s.done, ["remove 7", "remove 9", "end sessions", "forget 7,9"]);
});

test("if ending the sessions fails, the alert keeps the devices so you can try again", async () => {
  const s = steps("sessions");
  await assert.rejects(notMe([9], s.deps));
  assert.deepEqual(s.done, ["remove 9"]);
});

test("if removing a device fails, nothing else happens", async () => {
  const s = steps("remove");
  await assert.rejects(notMe([9], s.deps));
  assert.deepEqual(s.done, []);
});
