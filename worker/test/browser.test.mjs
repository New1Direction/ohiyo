import { test } from 'node:test';
import assert from 'node:assert/strict';
import dns from 'node:dns/promises';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isPublicAddress, validateApprovedUrl, fetchApprovedHtml, readPublicPage } from '../src/browser.mjs';

const url = 'https://example.com/';
function fixture(t, responses, addresses = [{ address: '93.184.216.34', family: 4 }]) {
  const calls = [];
  t.mock.method(dns, 'lookup', async () => addresses);
  t.mock.method(https, 'request', (target, options, callback) => {
    calls.push({ target: target.href, options });
    const spec = responses.shift();
    assert.ok(spec, 'No unexpected network requests');
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const response = Readable.from([Buffer.from(spec.body ?? '<title>Static</title><body>Hello</body>')]);
      response.statusCode = spec.status ?? 200;
      response.headers = { 'content-type': 'text/html', ...spec.headers };
      callback(response);
    });
    return request;
  });
  return calls;
}

test('global address boundaries reject private, reserved and transition addresses', () => {
  for (const ip of ['0.0.0.0', '0.255.255.255', '10.255.255.255', '100.64.0.0',
    '100.127.255.255', '127.0.0.1', '169.254.169.254', '172.16.0.0', '172.31.255.255',
    '192.0.0.9', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.19.255.255',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255', '::', '::1',
    '::ffff:8.8.8.8', '64:ff9b::808:808', 'fc00::1', 'fe80::1', 'ff02::1',
    '2001::1', '2001:20::1', '2001:db8::1', '2002:808:808::1', '3fff::1', 'garbage']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '100.63.255.255', '100.128.0.0',
    '172.15.255.255', '172.32.0.0', '198.17.255.255', '198.20.0.0', '223.255.255.255',
    '2001:4860:4860::8888', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
});

test('exact approval and HTTPS hostname policy', () => {
  assert.equal(validateApprovedUrl(url, [url]).href, url);
  for (const bad of ['http://example.com/', 'https://user:pass@example.com/', 'https://127.1/',
    'https://2130706433/', 'https://0x7f000001/', 'https://[2606:4700::1]/',
    'https://localhost/', 'https://example.com:8443/', 'https://example.com/#x']) {
    assert.throws(() => validateApprovedUrl(bad, [bad]));
  }
  for (const bad of ['https://example.com/other', 'https://EXAMPLE.com/', 'https://example.com/?q=x']) {
    assert.throws(() => validateApprovedUrl(bad, [url]), /exactly approved/);
  }
});

test('DNS pin is used by HTTPS and sends no ambient authority', async t => {
  const calls = fixture(t, [{}]);
  await fetchApprovedHtml({ url, approvedUrls: [url] });
  const opts = calls[0].options;
  assert.equal(opts.agent, false);
  assert.equal(opts.method, 'GET');
  assert.equal(opts.headers.Cookie, undefined);
  opts.lookup('attacker-changed-DNS', {}, (err, address, family) => {
    assert.equal(err, null); assert.equal(address, '93.184.216.34'); assert.equal(family, 4);
  });
  opts.lookup('ignored', { all: true }, (err, entries) => {
    assert.equal(err, null); assert.deepEqual(entries, [{ address: '93.184.216.34', family: 4 }]);
  });
});

test('mixed public/private DNS fails before opening HTTPS', async t => {
  const calls = fixture(t, [], [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }]);
  await assert.rejects(fetchApprovedHtml({ url, approvedUrls: [url] }), /non-public/);
  assert.equal(calls.length, 0);
});

test('redirects require exact approval, and approved redirects get fresh DNS validation', async t => {
  const calls = fixture(t, [{ status: 302, headers: { location: '/next' } }, {}]);
  await assert.rejects(fetchApprovedHtml({ url, approvedUrls: [url] }), /exactly approved/);
  assert.equal(calls.length, 1);
});

test('approved redirect completes and loop is bounded', async t => {
  const next = `${url}next`;
  const calls = fixture(t, [{ status: 302, headers: { location: '/next' } }, {}]);
  assert.equal((await fetchApprovedHtml({ url, approvedUrls: [url, next] })).url, next);
  assert.equal(calls.length, 2);
  assert.equal(dns.lookup.mock.callCount(), 2);
});

test('redirect loop limit', async t => {
  const calls = fixture(t, Array.from({ length: 4 }, () => ({ status: 302, headers: { location: url } })));
  await assert.rejects(fetchApprovedHtml({ url, approvedUrls: [url] }), /Redirect limit/);
  assert.equal(calls.length, 4);
});

test('approved redirect cannot rebind DNS to private IP', async t => {
  const calls = fixture(t, [{ status: 302, headers: { location: '/next' } }]);
  let lookups = 0;
  t.mock.method(dns, 'lookup', async () => [{
    address: lookups++ ? '169.254.169.254' : '8.8.8.8', family: 4,
  }]);
  await assert.rejects(fetchApprovedHtml({ url, approvedUrls: [url, `${url}next`] }), /non-public/);
  assert.equal(calls.length, 1);
});

test('cancels a stalled DNS lookup promptly without an HTTPS connection', async t => {
  const calls = fixture(t, []);
  t.mock.method(dns, 'lookup', () => new Promise(() => {}));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('cancel DNS')), 20);
  try {
    await assert.rejects(fetchApprovedHtml({ url, approvedUrls: [url], signal: controller.signal }), /cancel DNS/);
    assert.equal(calls.length, 0);
  } finally { clearTimeout(timer); }
});

test('rejects downloads, non-HTML, compression, bad status and oversized HTML', async t => {
  fixture(t, [
    { headers: { 'content-disposition': 'attachment; filename=x.html' } },
    { headers: { 'content-type': 'application/pdf' } },
    { headers: { 'content-encoding': 'gzip' } }, { status: 403 },
    { body: 'x'.repeat(2 * 1024 * 1024 + 1) },
  ]);
  for (let i = 0; i < 5; i++) await assert.rejects(fetchApprovedHtml({ url, approvedUrls: [url] }), /HTML|download|MiB/);
});

test('pre-cancellation does no DNS, network or evidence work', async t => {
  const calls = fixture(t, []);
  const signal = AbortSignal.abort(new Error('cancelled'));
  await assert.rejects(readPublicPage({ url, approvedUrls: [url], evidenceDirectory: '/unused', signal }), /cancelled/);
  assert.equal(calls.length, 0);
  assert.equal(dns.lookup.mock.callCount(), 0);
});

test('real Chromium freezes hostile HTML, bounds text, writes 2x PNG, and isolates calls', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kikka-browser-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = fixture(t, [{ body: `<title>Frozen</title>
    <meta http-equiv="refresh" content="0;url=https://evil.example/">
    <body><h1>Public fixture</h1>
    <script>document.title='EXECUTED';localStorage.secret='leak';fetch('https://evil.example/')</script>
    <iframe src="http://127.0.0.1/"></iframe><img src="https://evil.example/x">
    <form method="post" action="https://evil.example/"></form><p>${'a'.repeat(31000)}</p></body>` },
  { body: '<title>Fresh</title><body>Second isolated document<script>document.write(localStorage.secret)</script></body>' }]);
  const first = await readPublicPage({ url, approvedUrls: [url], evidenceDirectory: directory });
  assert.equal(first.title, 'Frozen');
  assert.equal(first.text.length, 30000);
  assert.match(first.text, /^UNTRUSTED WEBPAGE DATA/);
  assert.equal(first.verification, 'regional-page-only');
  assert.ok(first.limitations.length);
  const bytes = await readFile(path.join(directory, first.screenshot));
  assert.equal(bytes.readUInt32BE(16), 2560);
  assert.equal(bytes.readUInt32BE(20), 1440);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), first.sha256);
  const second = await readPublicPage({ url, approvedUrls: [url], evidenceDirectory: directory });
  assert.equal(second.title, 'Fresh');
  assert.doesNotMatch(second.text, /Public fixture|leak/);
  assert.notEqual(first.screenshot, second.screenshot);
  assert.equal(calls.length, 2);
  assert.deepEqual((await readdir(directory)).sort(), [first.screenshot, second.screenshot].sort());
});
