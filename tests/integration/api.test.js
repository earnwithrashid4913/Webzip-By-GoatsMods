'use strict';

/**
 * tests/integration/api.test.js — the real server, the real crawler, a local
 * fixture site, and the ZIP verified with the system `unzip` binary.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const { startTestServer } = require('../helpers/start');
const { startFixtureSite } = require('../helpers/fixture-site');

async function postZip(origin, body, headers = {}) {
  return fetch(`${origin}/api/zip`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

test('POST /api/zip — full archive cycle (Section J row 1)', async (t) => {
  const site = await startFixtureSite();
  const ctx = await startTestServer({ extraAllowedPorts: [site.port] });
  t.after(async () => { await ctx.close(); await site.close(); });

  const res = await postZip(ctx.origin, { url: `${site.origin}/` });
  const body = await res.arrayBuffer();
  assert.equal(res.status, 200, Buffer.from(body).toString('utf8').slice(0, 300));

  // --- the four documented response headers -----------------------------
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const disposition = res.headers.get('content-disposition');
  assert.match(disposition, /^attachment; filename="([^"]+)"$/);
  const dispositionName = disposition.match(/filename="([^"]+)"/)[1];
  assert.equal(dispositionName, `127-0-0-1-${ctx.config.filenameSuffix}.zip`);
  assert.equal(res.headers.get('x-file-name'), dispositionName, 'X-File-Name must match Content-Disposition');
  assert.equal(res.headers.get('x-source-url'), `${site.origin}/`);
  assert.ok(res.headers.get('x-request-id'), 'X-Request-Id is set');

  const bytes = Buffer.from(body);
  assert.equal(bytes.length, Number(res.headers.get('content-length')), 'Content-Length must be truthful');
  assert.ok(bytes.length > 0);
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'ZIP magic bytes');

  // --- verified with the system unzip binary ----------------------------
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'webzip-extract-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const zipPath = path.join(dir, 'archive.zip');
  await fsp.writeFile(zipPath, bytes);

  execFileSync('unzip', ['-t', zipPath], { stdio: 'pipe' }); // integrity
  const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
    .split('\n').map((l) => l.trim()).filter(Boolean);

  for (const expected of ['index.html', 'about/index.html', 'big/index.html', 'style.css', 'script.js', 'logo.svg', 'logo-2.svg']) {
    assert.ok(listing.includes(expected), `archive is missing ${expected}; got ${JSON.stringify(listing)}`);
  }
  assert.ok(!listing.some((e) => e.includes('private')), 'robots.txt-disallowed path was archived');
  assert.ok(!site.hits.includes('/private/secret'), 'robots.txt-disallowed page was even fetched');
  assert.ok(!listing.some((e) => e.includes('..')), 'no path-escape entries');
  assert.ok(!listing.some((e) => e.startsWith('/')), 'no absolute entry paths');
  assert.ok(!listing.some((e) => e.startsWith('../')), 'no parent-relative entry paths');
  assert.equal(new Set(listing).size, listing.length, 'duplicate entry names in the archive');

  // --- the extracted HTML is really the crawled page --------------------
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', dir], { stdio: 'pipe' });
  const html = await fsp.readFile(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /Fixture Home/);

  // --- cleanup: the job directory is gone -------------------------------
  await new Promise((r) => setTimeout(r, 150));
  const leftovers = await fsp.readdir(ctx.tempDir);
  assert.deepEqual(leftovers, [], `temp dir not cleaned: ${JSON.stringify(leftovers)}`);
});

test('error contract: 400 for missing / malformed / bad-scheme URLs', async (t) => {
  const site = await startFixtureSite();
  const ctx = await startTestServer({ extraAllowedPorts: [site.port], overrides: { RATE_LIMIT_MAX: '1000' } });
  t.after(async () => { await ctx.close(); await site.close(); });

  const cases = [
    [{}, 'required'],
    [{ url: '' }, 'required'],
    [{ url: 'not a url' }, 'valid http'],
    [{ url: 'ftp://example.com' }, 'Unsupported protocol'],
    [{ url: 'file:///etc/passwd' }, 'Unsupported protocol'],
    [{ url: 'http://169.254.169.254/latest/meta-data/' }, 'blocked'],
    [{ url: 'http://10.0.0.5/' }, 'blocked'],
    // NOTE: http://[::1]/ is NOT here on purpose — this suite runs with
    // SSRF_ALLOW_LOOPBACK=true to reach the fixture, and loopback is exactly
    // what that flag relaxes. The blocked case is covered in the unit suite.
    [{ url: 'http://metadata.google.internal/' }, 'not allowed'],
    [{ url: 'https://user:pass@example.com' }, 'credentials']
  ];

  for (const [body, match] of cases) {
    const res = await postZip(ctx.origin, body);
    const text = await res.text();
    assert.equal(res.status, 400, `${JSON.stringify(body)} -> ${res.status} ${text}`);
    const json = JSON.parse(text);
    assert.equal(json.code, 'INVALID_URL', text);
    assert.equal(json.isError, true);
    assert.equal(typeof json.error, 'string', 'error must be a readable string for the frontend toast');
    assert.match(json.message, new RegExp(match, 'i'), text);
    assert.ok(json.requestId, 'requestId present');
  }
});

test('malformed JSON body maps to 400 INVALID_URL, not 500', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const res = await postZip(ctx.origin, '{"url": ');
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.code, 'INVALID_URL');
  assert.match(json.message, /valid JSON/);
});

test('redirect to a private IP is rejected (504/502 are NOT used here)', async (t) => {
  const site = await startFixtureSite();
  const ctx = await startTestServer({ extraAllowedPorts: [site.port] });
  t.after(async () => { await ctx.close(); await site.close(); });

  const res = await postZip(ctx.origin, { url: `${site.origin}/redirect-private` });
  const text = await res.text();
  assert.equal(res.status, 400, text);
  const json = JSON.parse(text);
  assert.equal(json.code, 'INVALID_URL');
  assert.match(json.message, /blocked/i);
});

test('unreachable target -> 502 ARCHIVE_START_FAILED', async (t) => {
  const ctx = await startTestServer({ extraAllowedPorts: [1] }); // port 1: nothing listens
  t.after(() => ctx.close());

  const res = await postZip(ctx.origin, { url: 'http://127.0.0.1:1/' });
  const text = await res.text();
  assert.equal(res.status, 502, text);
  const json = JSON.parse(text);
  assert.equal(json.code, 'ARCHIVE_START_FAILED');
});

test('hanging target -> 504 ZIP_NOT_READY', async (t) => {
  const site = await startFixtureSite();
  const ctx = await startTestServer({
    extraAllowedPorts: [site.port],
    overrides: { JOB_TIMEOUT_MS: '1000', REQUEST_TIMEOUT_MS: '4000', RATE_LIMIT_MAX: '100' }
  });
  t.after(async () => { await ctx.close(); await site.close(); });

  const started = Date.now();
  const res = await postZip(ctx.origin, { url: `${site.origin}/slow` });
  const text = await res.text();
  assert.equal(res.status, 504, text);
  const json = JSON.parse(text);
  assert.equal(json.code, 'ZIP_NOT_READY');
  assert.ok(Date.now() - started < 8000, 'should time out near JOB_TIMEOUT_MS, not hang');

  // and the timed-out job's directory is cleaned up too
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(await fsp.readdir(ctx.tempDir), []);
});

test('MAX_PAGES exceeded -> 502 LIMITS_EXCEEDED, never a partial 200', async (t) => {
  const site = await startFixtureSite();
  const ctx = await startTestServer({
    extraAllowedPorts: [site.port],
    overrides: { MAX_PAGES: '4', MAX_DEPTH: '2', RATE_LIMIT_MAX: '1000' }
  });
  t.after(async () => { await ctx.close(); await site.close(); });

  const res = await postZip(ctx.origin, { url: `${site.origin}/links` });
  const text = await res.text();
  assert.equal(res.status, 502, text.slice(0, 300));

  const json = JSON.parse(text);
  assert.equal(json.code, 'LIMITS_EXCEEDED');
  assert.match(json.message, /MAX_PAGES/);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8', 'no ZIP headers on a failure');
  assert.equal(res.headers.get('content-disposition'), null);

  // the failed job must not leave anything on disk
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(await fsp.readdir(ctx.tempDir), []);
});

test('MAX_TOTAL_SIZE exhausted -> 502 LIMITS_EXCEEDED', async (t) => {
  const site = await startFixtureSite();
  const ctx = await startTestServer({
    extraAllowedPorts: [site.port],
    // 3 MB /big asset vs a 1 MB budget: the crawl must stop and fail clearly
    overrides: { MAX_TOTAL_SIZE: '1048576', MAX_FILE_SIZE: '1048576', RATE_LIMIT_MAX: '1000' }
  });
  t.after(async () => { await ctx.close(); await site.close(); });

  const res = await postZip(ctx.origin, { url: `${site.origin}/` });
  const text = await res.text();
  assert.equal(res.status, 502, text.slice(0, 300));
  assert.equal(JSON.parse(text).code, 'LIMITS_EXCEEDED');

  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(await fsp.readdir(ctx.tempDir), []);
});

test('a complete archive inside every limit still returns 200', async (t) => {
  const site = await startFixtureSite();
  const ctx = await startTestServer({ extraAllowedPorts: [site.port], overrides: { RATE_LIMIT_MAX: '1000' } });
  t.after(async () => { await ctx.close(); await site.close(); });

  const res = await postZip(ctx.origin, { url: `${site.origin}/` });
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(res.status, 200, bytes.toString('utf8').slice(0, 300));
  assert.equal(res.headers.get('content-type'), 'application/zip');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'webzip-complete-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const zipPath = path.join(dir, 'a.zip');
  await fsp.writeFile(zipPath, bytes);
  execFileSync('unzip', ['-t', zipPath], { stdio: 'pipe' });
  const listing = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(listing.includes('index.html'));
  assert.ok(listing.includes('big/index.html'), 'the 3 MB file fits under the 10 MB default cap');
});

test('MAX_FILE_SIZE exceeded -> 502 LIMITS_EXCEEDED with a precise message', async (t) => {
  const site = await startFixtureSite();
  const ctx = await startTestServer({
    extraAllowedPorts: [site.port],
    overrides: { MAX_FILE_SIZE: '10240', MAX_TOTAL_SIZE: '1048576', RATE_LIMIT_MAX: '1000' }
  });
  t.after(async () => { await ctx.close(); await site.close(); });

  const res = await postZip(ctx.origin, { url: `${site.origin}/` });
  const text = await res.text();
  assert.equal(res.status, 502, text.slice(0, 300));

  const json = JSON.parse(text);
  assert.equal(json.code, 'LIMITS_EXCEEDED');
  assert.match(json.message, /MAX_FILE_SIZE/);
  assert.match(json.message, /\/big exceeds 10240 bytes/);

  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(await fsp.readdir(ctx.tempDir), []);
});

test('a start URL that is itself oversized -> 502 LIMITS_EXCEEDED', async (t) => {
  const site = await startFixtureSite();
  const ctx = await startTestServer({
    extraAllowedPorts: [site.port],
    overrides: { MAX_FILE_SIZE: '10240', RATE_LIMIT_MAX: '1000' }
  });
  t.after(async () => { await ctx.close(); await site.close(); });

  const res = await postZip(ctx.origin, { url: `${site.origin}/big` });
  const text = await res.text();
  assert.equal(res.status, 502, text);
  assert.equal(JSON.parse(text).code, 'LIMITS_EXCEEDED');
});

test('rate limiting answers 429 with Retry-After', async (t) => {
  const site = await startFixtureSite();
  const ctx = await startTestServer({
    extraAllowedPorts: [site.port],
    overrides: { RATE_LIMIT_MAX: '2', RATE_LIMIT_WINDOW_MS: '60000' }
  });
  t.after(async () => { await ctx.close(); await site.close(); });

  await postZip(ctx.origin, { url: 'not-a-url' });
  await postZip(ctx.origin, { url: 'not-a-url' });
  const res = await postZip(ctx.origin, { url: 'not-a-url' });
  assert.equal(res.status, 429);
  const json = await res.json();
  assert.equal(json.code, 'RATE_LIMITED');
  assert.ok(Number(res.headers.get('retry-after')) >= 1);
});

test('concurrency: over MAX_CONCURRENT_JOBS -> 502 (no new status codes)', async (t) => {
  const site = await startFixtureSite();
  const ctx = await startTestServer({
    extraAllowedPorts: [site.port],
    overrides: { MAX_CONCURRENT_JOBS: '1', ADMISSION_QUEUE_TIMEOUT_MS: '1', JOB_TIMEOUT_MS: '1500', RATE_LIMIT_MAX: '100' }
  });
  t.after(async () => { await ctx.close(); await site.close(); });

  const [a, b] = await Promise.all([
    postZip(ctx.origin, { url: `${site.origin}/slow` }),
    postZip(ctx.origin, { url: `${site.origin}/slow` })
  ]);
  const statuses = [a.status, b.status].sort();
  assert.ok(statuses.includes(502), `expected one 502, got ${JSON.stringify(statuses)}`);
  const blocked = a.status === 502 ? await a.json() : await b.json();
  assert.equal(blocked.code, 'ARCHIVE_START_FAILED');
});

test('health endpoints expose aggregates only', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const live = await fetch(`${ctx.origin}/health`);
  assert.equal(live.status, 200);
  const liveBody = await live.json();
  assert.deepEqual(Object.keys(liveBody).sort(), ['status', 'uptime']);

  const ready = await fetch(`${ctx.origin}/api/health`);
  assert.equal(ready.status, 200);
  const readyBody = await ready.json();
  assert.equal(readyBody.status, 'ok');
  assert.equal(readyBody.activeJobs, 0);
  assert.equal(readyBody.maxConcurrentJobs, ctx.config.maxConcurrentJobs);
  assert.equal(typeof readyBody.storageUsedMb, 'number');
  assert.ok(!JSON.stringify(readyBody).includes('127.0.0.1'), 'no client IPs or URLs leaked');
});

test('the frontend is served at / and source files are not exposed', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const page = await fetch(`${ctx.origin}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /<title>WebZip — Download Any Website<\/title>/);

  const disk = await fsp.readFile(path.resolve(__dirname, '..', '..', 'index.html'), 'utf8');
  assert.equal(html, disk, 'index.html must be served byte-for-byte, untouched');

  for (const leak of ['/src/server.js', '/src/config/config.js', '/package.json', '/.env.example']) {
    const res = await fetch(`${ctx.origin}${leak}`);
    assert.equal(res.status, 404, `${leak} must not be served`);
  }
});

test('unknown routes and methods return JSON, never HTML stack traces', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const notFound = await fetch(`${ctx.origin}/nope`);
  assert.equal(notFound.status, 404);
  assert.match(notFound.headers.get('content-type'), /application\/json/);
  assert.equal((await notFound.json()).code, 'NOT_FOUND');

  const wrongMethod = await fetch(`${ctx.origin}/api/zip`, { method: 'GET' });
  assert.equal(wrongMethod.status, 404);
});

test('a real hostname exercises the DNS-pinning path end to end', async (t) => {
  const dns = require('node:dns').promises;
  try {
    await dns.lookup('example.com');
  } catch (_) {
    t.skip('no DNS resolver in this environment');
    return;
  }

  const ctx = await startTestServer({
    overrides: { REQUEST_TIMEOUT_MS: '4000', JOB_TIMEOUT_MS: '8000', RATE_LIMIT_MAX: '100' }
  });
  t.after(() => ctx.close());

  const res = await postZip(ctx.origin, { url: 'https://example.com/' });
  const text = await res.text();

  // With real egress this returns a ZIP; in a sandbox without outbound TCP it
  // returns a clean 502. Either way, a lookup-contract failure is a bug.
  assert.doesNotMatch(text, /Invalid IP address/, 'the pinned lookup returned the wrong shape');
  assert.doesNotMatch(text, /No DNS pin/, 'the pin was missing when connecting');
  assert.ok([200, 502].includes(res.status), `unexpected status ${res.status}: ${text.slice(0, 300)}`);
  if (res.status === 502) {
    assert.match(text, /connect|ETIMEDOUT|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|failed/i);
  }
});

test('MAX_URL_LENGTH and the request body limit are enforced', async (t) => {
  const ctx = await startTestServer({
    overrides: { MAX_URL_LENGTH: '64', REQUEST_BODY_LIMIT: '16kb', RATE_LIMIT_MAX: '1000' }
  });
  t.after(() => ctx.close());

  const longUrl = `https://example.com/${'a'.repeat(200)}`;
  const tooLong = await postZip(ctx.origin, { url: longUrl });
  assert.equal(tooLong.status, 400);
  const json = JSON.parse(await tooLong.text());
  assert.equal(json.code, 'INVALID_URL');
  assert.match(json.message, /too long \(max 64 characters\)/);

  // a short URL still passes the same validator
  const okUrl = await postZip(ctx.origin, { url: 'http://169.254.169.254/' });
  assert.equal(okUrl.status, 400);
  assert.match((await okUrl.json()).message, /blocked/);

  // body larger than REQUEST_BODY_LIMIT
  const fat = await postZip(ctx.origin, { url: 'https://example.com', pad: 'x'.repeat(32 * 1024) });
  assert.equal(fat.status, 400);
  const fatJson = JSON.parse(await fat.text());
  assert.equal(fatJson.code, 'INVALID_URL');
  assert.match(fatJson.message, /too large/);
});

test('the access log records real request paths, not router-relative ones', async (t) => {
  const { buildApp } = require('../../src/server');
  const { loadConfig } = require('../../src/config/config');

  const logged = [];
  const fakeLogger = {
    // pino passes the message as the second argument, not inside the object.
    info: (obj, msg) => logged.push({ ...obj, msg }),
    warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {}, child: () => fakeLogger
  };
  const config = loadConfig({
    NODE_ENV: 'test', SSRF_ALLOW_LOOPBACK: 'true', TEMP_DIR: '/tmp/webzip-logtest',
    ALLOWED_PORTS: '80,443,65000'
  });
  const { app } = buildApp({ config, logger: fakeLogger });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  await new Promise((r) => server.once('listening', r));

  const base = `http://127.0.0.1:${server.address().port}`;
  // Bodies must be consumed: the 'finish' event (which writes the log line)
  // only fires once the response has actually been flushed.
  for (const r of [
    await fetch(`${base}/api/health`),
    await fetch(`${base}/health`),
    await fetch(`${base}/api/zip?leak=secret`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
  ]) {
    await r.text();
  }
  await new Promise((r) => setTimeout(r, 30));

  const paths = logged.filter((l) => l.msg === 'request').map((l) => l.path);
  assert.ok(paths.includes('/api/health'), `expected /api/health, got ${JSON.stringify(paths)}`);
  assert.ok(paths.includes('/health'), `expected /health, got ${JSON.stringify(paths)}`);
  assert.ok(paths.includes('/api/zip'), `expected /api/zip, got ${JSON.stringify(paths)}`);
  assert.ok(!JSON.stringify(logged).includes('secret'), 'query strings must never reach the log');
});
