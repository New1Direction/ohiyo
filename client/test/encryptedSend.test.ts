// Tests for what may leave the device for a chat in encrypted mode (send / edit / retry):
// ciphertext or a thrown error, never the plaintext, and a group never falls back to
// the one-to-one path. Also the one-in-flight sender-key distribution per channel.
//   node --experimental-strip-types --test test/encryptedSend.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createDistributionTracker,
  encryptOutgoing,
  EncryptedSendError,
  forwardBlockReason,
} from "../src/lib/encryptedSend.ts";

const PLAINTEXT = "meet at noon";

type Calls = { ensure: number; group: number; pairwise: number };

function fakeCrypto(opts: {
  ensure?: () => Promise<void>;
  group?: string | null;
  pairwise?: string | null;
}): { calls: Calls; enc: Parameters<typeof encryptOutgoing>[2] } {
  const calls: Calls = { ensure: 0, group: 0, pairwise: 0 };
  return {
    calls,
    enc: {
      ensureSenderKey: () => {
        calls.ensure++;
        return opts.ensure ? opts.ensure() : Promise.resolve();
      },
      groupEncrypt: async () => {
        calls.group++;
        return opts.group === undefined ? "grp1.ciphertext" : opts.group;
      },
      pairwiseEncrypt: async () => {
        calls.pairwise++;
        return opts.pairwise === undefined ? "sig2.ciphertext" : opts.pairwise;
      },
    },
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settled = async <T,>(p: Promise<T>): Promise<boolean> => {
  let done = false;
  void p.then(
    () => (done = true),
    () => (done = true),
  );
  for (let i = 0; i < 5; i++) await Promise.resolve();
  return done;
};

test("a group message encrypts with the sender key once it is distributed", async () => {
  const { calls, enc } = fakeCrypto({});
  assert.equal(await encryptOutgoing("group_dm", PLAINTEXT, enc), "grp1.ciphertext");
  assert.deepEqual(calls, { ensure: 1, group: 1, pairwise: 0 });
});

test("a group message is never sent as plaintext when group encryption gives no ciphertext", async () => {
  const { calls, enc } = fakeCrypto({ group: null });
  await assert.rejects(encryptOutgoing("group_dm", PLAINTEXT, enc), EncryptedSendError);
  assert.equal(calls.pairwise, 0, "a group must never fall back to the one-to-one path");
});

test("a failed sender-key distribution fails the send before anything is encrypted", async () => {
  const { calls, enc } = fakeCrypto({ ensure: () => Promise.reject(new Error("listRecipients failed")) });
  await assert.rejects(encryptOutgoing("group_dm", PLAINTEXT, enc), /listRecipients failed/);
  assert.equal(calls.group, 0);
  assert.equal(calls.pairwise, 0);
});

test("group encryption waits for the in-flight distribution", async () => {
  const gate = deferred();
  const { calls, enc } = fakeCrypto({ ensure: () => gate.promise });
  const sending = encryptOutgoing("group_dm", PLAINTEXT, enc);
  assert.equal(await settled(sending), false);
  assert.equal(calls.group, 0, "must not encrypt before our sender key is distributed");
  gate.resolve();
  assert.equal(await sending, "grp1.ciphertext");
});

test("a DM encrypts pairwise, and fails instead of sending plaintext without a session", async () => {
  const ok = fakeCrypto({});
  assert.equal(await encryptOutgoing("dm", PLAINTEXT, ok.enc), "sig2.ciphertext");
  assert.equal(ok.calls.group, 0);
  const none = fakeCrypto({ pairwise: null });
  await assert.rejects(encryptOutgoing("dm", PLAINTEXT, none.enc), (err: unknown) => {
    return err instanceof EncryptedSendError && err.reason === "no-signal-session";
  });
});

test("a channel that is not a DM or group (or is not known yet) gets no encrypted send", async () => {
  for (const type of ["text", "voice", undefined] as const) {
    const { calls, enc } = fakeCrypto({});
    await assert.rejects(encryptOutgoing(type, PLAINTEXT, enc), EncryptedSendError);
    assert.deepEqual(calls, { ensure: 0, group: 0, pairwise: 0 });
  }
});

test("concurrent distributions for a channel share one run and every caller waits for it", async () => {
  const tracker = createDistributionTracker();
  const gate = deferred();
  let runs = 0;
  const run = () => {
    runs++;
    return gate.promise;
  };
  const first = tracker.ensure("g", run);
  const second = tracker.ensure("g", run);
  assert.equal(runs, 1);
  assert.equal(await settled(second), false, "a second caller must wait for the in-flight run");
  gate.resolve();
  await Promise.all([first, second]);
  await tracker.ensure("g", run);
  assert.equal(runs, 1, "a finished distribution is not repeated");
});

test("a failed distribution rejects every waiter and the next call runs again", async () => {
  const tracker = createDistributionTracker();
  const gate = deferred();
  let runs = 0;
  const failing = () => {
    runs++;
    return gate.promise;
  };
  const first = tracker.ensure("g", failing);
  const second = tracker.ensure("g", failing);
  gate.reject(new Error("network down"));
  await assert.rejects(first, /network down/);
  await assert.rejects(second, /network down/);
  await tracker.ensure("g", async () => {
    runs++;
  });
  assert.equal(runs, 2, "a failure is not remembered as done");
});

test("forget() makes the next call distribute again, even while a run is in flight", async () => {
  const tracker = createDistributionTracker();
  const stale = deferred();
  let runs = 0;
  const staleRun = tracker.ensure("g", () => {
    runs++;
    return stale.promise;
  });
  tracker.forget("g"); // our key rotated: the in-flight run carries the old key
  const fresh = tracker.ensure("g", async () => {
    runs++;
  });
  await fresh;
  stale.resolve();
  await staleRun;
  assert.equal(runs, 2);
  await tracker.ensure("g", async () => {
    runs++;
  });
  assert.equal(runs, 2, "the fresh run's success is remembered");
  tracker.forget("g");
  await tracker.ensure("g", async () => {
    runs++;
  });
  assert.equal(runs, 3);
});

test("forwarding into a chat in encrypted mode is refused (it would go out as plaintext)", () => {
  assert.equal(forwardBlockReason({}, true), "Can't forward into an encrypted chat yet.");
});

test("forwarding a message decrypted on this device is refused", () => {
  assert.equal(forwardBlockReason({ _encrypted: true }, false), "Encrypted messages can't be forwarded yet.");
});

test("forwarding a plaintext message into a plaintext chat is allowed", () => {
  assert.equal(forwardBlockReason({}, false), null);
  assert.equal(forwardBlockReason({ _encrypted: false }, false), null);
});
