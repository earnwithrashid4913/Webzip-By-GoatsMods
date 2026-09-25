'use strict';

/**
 * tests/integration/hardening.test.js — the 300 MB / 700 MB / 24x7 concerns:
 * IP spoofing, lock release, client aborts, orphan cleanup, repeated jobs,
 * resource guards and leak detection.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { startTestServer } = require('../helpers/start');
const { startFixtureSite } = require('../helpers/fixture-site');

async function waitFor(predicate, { timeoutMs = 3000, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
}

async function postZip(origin, body, headers = {}) {
  return fetch(`${origin}/api/zip`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body)
  });
}

test('TRUST_PROXY=0: spoofed X-Forwarded-For cannot dodge the rate limiter', async (t) => {
  const ctx = await startTestServer({ overrides: { RATE_LIMIT_MAX: '3', TRUST_PROXY: '0' } });
  t.after(() => ctx.close());

  // Same socket, a different forged client IP on every request.
  for (let i = 0; i < 3; i++) {
    await postZip(ctx.origin, { url: 'not-a-url' }, { 'x-forwarded-for': `203.0.113.${i + 1}` });
  }
  const res = await postZip(ctx.origin, { url: 'not-a-url' }, { 'x-forwarded-for': '203.0.113.99' });
  assert.equal(res.status, 429, 'the real socket IP must be the rate-limit key');
});

test('TRUST_PROXY=1: a real proxy hop IS trusted (why the default must stay 0)', async (t) => {
  const ctx = await startTestServer({ overrides: { RATE_LIMIT_MAX: '1', TRUST_PROXY: '1' } });
  t.after(() => ctx.close());

  await postZip(ctx.origin, { url: 'not-a-url' }, { 'x-forwarded-for': '198.51.100.1' });
  const other = await postZip(ctx.origin, { url: 'not-a-url' }, { 'x-forwarded-for': '198.51.100.2' });
  assert.equal(other.status, 400, 'behind a trusted proxy the forwarded IP is the client');
});

test('TRUST_PROXY=true is refused at boot, so it cannot be enabled by accident', async (t) => {
  await assert.rejects(
    startTestServer({ overrides: { TRUST_PROXY: 'true' } }),
    /refused.*spoof/i
  );
});

test('a timed-out job releases its slot so the next job runs', async (t) => {
  const site = await startFixtureSite();
  const ctx = await startTestServer({
    extraAllowedPorts: [site.port],
    overrides: {
      JOB_TIMEOUT_MS: '1000', REQUEST_TIMEOUT_MS: '5000',
      MAX_CONCURRENT_JOBS: '1', RATE_LIMIT_MAX: '1000'
    }
  });
  t.after(async () => { await ctx.close(); await site.close(); });

  const timedOut = await postZip(ctx.origin, { url: `${site.origin}/slow` });
  assert.equal(timedOut.status, 504, await timedOut.text());

  // The timed-out job must already be out of the registry and off disk.
  const afterTimeout = await (await fetch(`${ctx.origin}/api/health`)).json();
  assert.equal(afterTimeout.activeJobs, 0, 'the timed-out job must not linger in the registry');

  // The semaphore must be free again, otherwise this hangs or 502s.
  const next = await postZip(ctx.origin, { url: `${site.origin}/about` });
  const body = await next.arrayBuffer(); // read it fully so the job is released
  assert.equal(next.status, 200, Buffer.from(body).toString('utf8').slice(0, 200));

  // The client sees the final body byte a moment before the server's own
  // 'close' handler deregisters the job, so poll instead of racing it.
  await waitFor(async () => (await (await fetch(`${ctx.origin}/api/health`)).json()).activeJobs === 0,
    { label: 'no zombie job left in the registry' });
  await waitFor(async () => (await fsp.readdir(ctx.tempDir)).length === 0,
    { label: 'temp dir empty after a timeout followed by a success' });
});

test('an aborted client connection does not break the server or leak a job dir', async (t) => {
  const site = await startFixtureSite();
  const ctx = await startTestServer({ extraAllowedPorts: [site.port], overrides: { RATE_LIMIT_MAX: '1000' } });
  t.after(async () => { await ctx.close(); await site.close(); });

  const url = new URL(`${ctx.origin}/api/zip`);
  await new Promise((resolve) => {
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { 'content-type': 'application/json' } },
      (res) => { res.on('data', () => {}); res.on('end', resolve); }
    );
    req.on('error', () => {}); // the destroy below causes this
    req.end(JSON.stringify({ url: `${site.origin}/` }));
    setTimeout(() => req.destroy(), 5); // hang up mid-flight
    setTimeout(resolve, 400);
  });

  const health = await fetch(`${ctx.origin}/api/health`);
  assert.equal(health.status, 200, 'server still alive after a client hang-up');
  assert.equal((await health.json()).activeJobs, 0, 'the aborted job left the registry');

  await waitFor(async () => (await fsp.readdir(ctx.tempDir)).length === 0,
    { label: 'temp dir empty after a client abort' });

  // and a normal job still works afterwards
  const again = await postZip(ctx.origin, { url: `${site.origin}/about` });
  assert.equal(again.status, 200, await again.text());
});

test('boot sweep removes orphaned job directories from a previous crash', async (t) => {
  const site = await startFixtureSite();
  const ctx = await startTestServer({
    extraAllowedPorts: [site.port],
    beforeStart: async (tempDir) => {
      await fsp.mkdir(path.join(tempDir, 'deadbeef0000', 'files'), { recursive: true });
      await fsp.writeFile(path.join(tempDir, 'deadbeef0000', 'files', 'orphan.bin'), 'x');
      await fsp.mkdir(path.join(tempDir, 'cafe12345678'), { recursive: true });
    }
  });
  t.after(async () => { await ctx.close(); await site.close(); });

  assert.deepEqual(await fsp.readdir(ctx.tempDir), [], 'orphaned directories must be swept at boot');
});

test('MAX_TEMP_DISK_MB refuses new jobs when the temp volume is full', async (t) => {
  const site = await startFixtureSite();
  const ctx = await startTestServer({
    extraAllowedPorts: [site.port],
    overrides: {
      MAX_TEMP_DISK_MB: '1', MAX_TOTAL_SIZE: '262144', MAX_FILE_SIZE: '131072',
      RATE_LIMIT_MAX: '1000'
    },
    beforeStart: async (tempDir) => {
      await fsp.writeFile(path.join(tempDir, 'leftover.bin'), Buffer.alloc(2 * 1024 * 1024, 1));
    }
  });
  t.after(async () => { await ctx.close(); await site.close(); });

  const res = await postZip(ctx.origin, { url: `${site.origin}/about` });
  const text = await res.text();
  assert.equal(res.status, 502, text);
  const json = JSON.parse(text);
  assert.equal(json.code, 'ARCHIVE_START_FAILED');
  assert.match(json.message, /storage is full/i);
});

test('MAX_RSS_MB refuses new jobs under memory pressure', async (t) => {
  const site = await startFixtureSite();
  const ctx = await startTestServer({
    extraAllowedPorts: [site.port],
    overrides: { MAX_RSS_MB: '1', MAX_TEMP_DISK_MB: '400', RATE_LIMIT_MAX: '1000' }
  });
  t.after(async () => { await ctx.close(); await site.close(); });

  const res = await postZip(ctx.origin, { url: `${site.origin}/about` });
  const text = await res.text();
  assert.equal(res.status, 502, text);
  assert.equal(JSON.parse(text).code, 'ARCHIVE_START_FAILED');
  assert.match(JSON.parse(text).message, /memory pressure/i);
});

test('repeated jobs: no temp-dir growth, no runaway RSS, server stays healthy', async (t) => {
  const site = await startFixtureSite();
  const ctx = await startTestServer({ extraAllowedPorts: [site.port], overrides: { RATE_LIMIT_MAX: '10000' } });
  t.after(async () => { await ctx.close(); await site.close(); });

  const rssBefore = process.memoryUsage().rss;
  const handlesBefore = process._getActiveHandles().length;
  const requestsBefore = process._getActiveRequests().length;

  for (let i = 0; i < 6; i++) {
    const res = await postZip(ctx.origin, { url: `${site.origin}/` });
    const body = await res.arrayBuffer(); // consume fully so the stream closes
    assert.equal(res.status, 200, `job ${i + 1}: ${Buffer.from(body).toString('utf8').slice(0, 200)}`);
    await waitFor(async () => (await fsp.readdir(ctx.tempDir)).length === 0,
      { label: `temp dir empty after job ${i + 1}` });
  }

  // Force a GC-independent view: RSS never shrinks in Node, so assert the
  // *growth* across 6 full archive cycles stays bounded.
  const growthMb = (process.memoryUsage().rss - rssBefore) / 1048576;
  assert.ok(growthMb < 60, `RSS grew ${growthMb.toFixed(1)} MB across 6 jobs - possible leak`);

  // File-descriptor / socket / timer leak check: every handle opened by a job
  // must be released when it finishes.
  const handlesAfter = process._getActiveHandles().length;
  const requestsAfter = process._getActiveRequests().length;
  assert.ok(handlesAfter - handlesBefore < 20, `active handles grew ${handlesAfter - handlesBefore} (${handlesBefore} -> ${handlesAfter}) - fd/socket/timer leak`);
  assert.ok(requestsAfter - requestsBefore < 5, `pending requests grew ${requestsAfter - requestsBefore} - unawaited I/O`);

  const health = await fetch(`${ctx.origin}/api/health`);
  const stats = await health.json();
  assert.equal(stats.activeJobs, 0);
  assert.equal(stats.storageUsedMb, 0, 'temp storage back to zero');
});

test('a failing website never takes the server down', async (t) => {
  const site = await startFixtureSite();
  const ctx = await startTestServer({ extraAllowedPorts: [site.port, 1], overrides: { RATE_LIMIT_MAX: '10000' } });
  t.after(async () => { await ctx.close(); await site.close(); });

  const hostile = [
    { url: `${site.origin}/dead-end` }, // 500 page
    { url: 'http://127.0.0.1:1/' }, // connection refused
    { url: 'https://127.0.0.1:1/' }, // TLS to a dead port
    {}, // missing url
    { url: 'http://169.254.169.254/' }, // metadata
    { url: `${site.origin}/redirect-private` } // SSRF via redirect
  ];

  for (const body of hostile) {
    const res = await postZip(ctx.origin, body);
    assert.ok([400, 502, 504].includes(res.status), `${JSON.stringify(body)} -> ${res.status}`);
    await res.text();
  }

  const health = await fetch(`${ctx.origin}/api/health`);
  assert.equal(health.status, 200, 'server must survive every hostile request');
  const ok = await postZip(ctx.origin, { url: `${site.origin}/about` });
  assert.equal(ok.status, 200, 'still able to serve a valid job afterwards');
});
