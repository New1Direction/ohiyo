import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPUTER_CONTRACT_VERSION, validateComputerAction, validateComputerIdentity, validateComputerCapabilities } from '../src/computer-contract.mjs';

test('v1 contract rejects effect downgrades, unsafe navigation and unknown idempotency claims', () => {
  const policy = { allowed_urls: ['https://example.com/', 'https://example.com/one-time'], read_only_urls: ['https://example.com/'] };
  const navigate = { operation: 'browser.navigate', args: { url: 'https://example.com/' }, replay_class: 'non_idempotent_effect' };
  validateComputerAction(navigate, policy);
  validateComputerAction({ ...navigate, replay_class: 'read_only' }, policy);
  assert.throws(() => validateComputerAction({ ...navigate, args: { url: 'https://example.com/one-time' }, replay_class: 'read_only' }, policy), /classification/);
  assert.throws(() => validateComputerAction({ ...navigate, args: { url: 'https://elsewhere.test/' } }, policy), /grant/);
  assert.throws(() => validateComputerAction({ operation: 'desktop.type', args: { window_id: 9, text: 'x' }, replay_class: 'read_only' }), /classification/);
  assert.throws(() => validateComputerAction({ operation: 'files.ensure_directory', args: { path: 'notes' }, replay_class: 'idempotent_effect' }), /invariant/);
  validateComputerAction({ operation: 'files.ensure_directory', args: { path: 'notes' }, replay_class: 'idempotent_effect', invariant: 'mkdir_exists_v1' });
  assert.throws(() => validateComputerAction({ operation: 'files.read', args: { path: '../other' }, replay_class: 'read_only' }), /path/);
});

test('identity and feature discovery are versioned and complete', () => {
  const identity = { account: 'a', workspace_id: 'w', task_id: 't', root_goal_id: 'r', request_id: 'op' };
  validateComputerIdentity(identity);
  assert.throws(() => validateComputerIdentity({ ...identity, workspace_id: '' }), /workspace/);
  const features = { contract_version: COMPUTER_CONTRACT_VERSION, features: ['files.read'], persistence: { workspace: false, profile: false }, limitations: ['Re-authentication required after replacement.'] };
  validateComputerCapabilities(features);
  assert.throws(() => validateComputerCapabilities({ ...features, contract_version: '2.0.0' }), /mismatch/);
});
