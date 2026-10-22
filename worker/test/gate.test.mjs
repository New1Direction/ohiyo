import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spendingGate } from '../src/gate.mjs';

const model = { id: 'test', provider: 'openai', api: 'openai-responses', baseUrl: 'https://api.openai.com/v1', reasoning: false,
  contextWindow: 128000, cost: { input: 0.15, cacheRead: 0.075, cacheWrite: 0, output: 0.6 } };
const policy = { provider: 'openai', modelId: 'test', inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.6, maxOutputTokens: 4096 };
test('all paid paths share reservations; cached acknowledgements replay free; unknown outcomes retain reservations', async () => {
  const db = new DatabaseSync(':memory:');
  let id = 'generation-1', calls = 0, blocked = '', fail = false;
  const options = { db, policy, budgetMicros: 50000, identity: async () => id, stopped: () => false,
    activity() {}, blocked: text => { blocked = text; }, models: { completeSimple: async () => {
      calls++; if (fail) throw new Error('connection lost after acceptance');
      return { stopReason: 'stop', content: [{ type: 'text', text: 'receipt' }] };
    } } };
  const gate = spendingGate(options);
  const input = { messages: [] };
  assert.equal((await gate.models.completeSimple(model, input)).stopReason, 'stop');
  assert.equal(gate.reserved(), 21658); // 128000 × .15 + 4096 × .6, rounded UP.
  await gate.models.streamSimple(model, input).result(); assert.equal(calls, 1);
  id = 'compaction-1'; fail = true;
  assert.equal((await gate.models.completeSimple(model, input)).stopReason, 'error');
  assert.equal(gate.reserved(), 43316); assert.equal(gate.uncertain(), true);
  const reopened = spendingGate(options);
  id = 'fresh-retry';
  await reopened.models.streamSimple(model, input).result();
  assert.equal(calls, 2); assert.match(blocked, /unknown outcome/);
  assert.equal(reopened.reserved(), 43316);
  db.close();
});
test('compaction and ordinary requests cannot exceed the cumulative budget or use other paid APIs', async () => {
  const db = new DatabaseSync(':memory:'); let id = 'first', calls = 0;
  const gate = spendingGate({ db, policy, budgetMicros: 30000, identity: async () => id, stopped: () => false,
    blocked() {}, activity() {}, models: { completeSimple: async () => { calls++; return { stopReason: 'stop' }; } } });
  await gate.models.complete(model, {});
  id = 'manual-compaction'; assert.equal((await gate.models.completeSimple(model, {})).stopReason, 'error');
  assert.equal(calls, 1); assert.equal(gate.reserved(), 21658);
  assert.throws(() => gate.models.generateImages(), /not approved/);
  db.close();
});

test('a stop arriving during journal inspection prevents provider dispatch', async () => {
  const db = new DatabaseSync(':memory:');
  let stopped = false, release, calls = 0;
  const gate = spendingGate({ db, policy, budgetMicros: 30000,
    identity: () => new Promise(resolve => { release = resolve; }), stopped: () => stopped,
    blocked() {}, activity() {}, models: { completeSimple: async () => { calls++; return { stopReason: 'stop' }; } } });
  const result = gate.models.completeSimple(model, {});
  stopped = true; release('pending-request');
  assert.equal((await result).stopReason, 'error');
  assert.equal(calls, 0); assert.equal(gate.reserved(), 0);
  db.close();
});

test('private computer control holds generation before spending and Stop wins over handback', async () => {
  for (const stop of [false, true]) {
    const db = new DatabaseSync(':memory:');
    let privateControl = true, stopped = false, calls = 0, entered, release;
    const waiting = new Promise(r => { entered = r; });
    const hold = new Promise(r => { release = r; });
    const gate = spendingGate({ db, policy, budgetMicros: 30000,
      identity: async () => 'same-durable-generation', stopped: () => stopped,
      computerControl: { active: () => privateControl, wait: async () => { entered(); await hold; } },
      blocked() {}, activity() {}, models: { completeSimple: async () => { calls++; return { stopReason: 'stop' }; } } });
    const result = gate.models.completeSimple(model, {});
    await waiting;
    assert.equal(calls, 0); assert.equal(gate.reserved(), 0);
    stopped = stop; privateControl = false; release();
    assert.equal((await result).stopReason, stop ? 'error' : 'stop');
    assert.equal(calls, stop ? 0 : 1); assert.equal(gate.reserved(), stop ? 0 : 21658);
    db.close();
  }
});
