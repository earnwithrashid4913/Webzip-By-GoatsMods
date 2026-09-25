'use strict';

/**
 * tests/integration/process.test.js — 24/7 stability, tested in REAL child
 * processes (an in-process test cannot observe its own exit code or crash).
 *
 * Covers: unhandled rejections, uncaught exceptions, unsafe production config
 * being refused at boot, and graceful SIGTERM/SIGINT shutdown.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'src', 'server.js');
const { getFreePort } = require('../helpers/start');

function runChild(code, env = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', code], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child timed out')); }, timeoutMs);
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

async function withTempDir(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'webzip-proc-'));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('unhandledRejection is logged as fatal and exits 1 (no silent zombie)', async () => {
  const { code, stderr } = await runChild(
    `require(${JSON.stringify(SERVER)}).installProcessGuards();
     Promise.reject(new Error('boom'));`
  );
  assert.equal(code, 1);
  assert.match(stderr, /"level":"fatal"/);
  assert.match(stderr, /unhandledRejection/);
  assert.match(stderr, /boom/);
});

test('uncaughtException is logged as fatal and exits 1', async () => {
  const { code, stderr } = await runChild(
    `require(${JSON.stringify(SERVER)}).installProcessGuards();
     setTimeout(() => { throw new Error('kaboom'); }, 1);`
  );
  assert.equal(code, 1);
  assert.match(stderr, /"level":"fatal"/);
  assert.match(stderr, /uncaughtException/);
  assert.match(stderr, /kaboom/);
});

test('boot refuses SSRF_ALLOW_LOOPBACK=true in production (test-only bypass)', async () => {
  await withTempDir(async (dir) => {
    const port = await getFreePort();

    // Spawn the real production entry point with the unsafe combination.
    const child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production', SSRF_ALLOW_LOOPBACK: 'true',
        PORT: String(port), HOST: '127.0.0.1', TEMP_DIR: dir
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => { stdout += d; });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('child hung')); }, 10000);
      child.on('close', (c) => { clearTimeout(timer); resolve(c); });
    });

    assert.equal(code, 1, 'an unsafe production config must abort the boot');
    assert.match(stderr, /SSRF_ALLOW_LOOPBACK=true is refused when NODE_ENV=production/);
    assert.match(stderr, /"level":"fatal"/);
    assert.ok(!/listening/.test(stdout), 'the server must never start with an unsafe config');
  });
});

test('SIGTERM drains and exits 0 with a clean shutdown log', async () => {
  await withTempDir(async (dir) => {
    const port = await getFreePort();
    const child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1',
        TEMP_DIR: dir, LOG_LEVEL: 'info'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });

    // wait for "listening"
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
      const check = setInterval(() => {
        if (/WebZip backend listening/.test(out)) { clearInterval(check); clearTimeout(timer); resolve(); }
      }, 50);
    });

    // health must answer before we ask it to stop
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);

    const exitPromise = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    child.kill('SIGTERM');
    const { code } = await exitPromise;

    assert.equal(code, 0, `expected a clean exit, got ${code}\n${out}`);
    assert.match(out, /signal received/);
    assert.match(out, /shutdown complete/);
    assert.deepEqual(await fsp.readdir(dir), [], 'temp dir must be clean after shutdown');
  });
});

test('SIGINT also shuts down cleanly', async () => {
  await withTempDir(async (dir) => {
    const port = await getFreePort();
    const child = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: {
        ...process.env,
        NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1',
        TEMP_DIR: dir, LOG_LEVEL: 'info'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('server did not start')), 15000);
      const check = setInterval(() => {
        if (/WebZip backend listening/.test(out)) { clearInterval(check); clearTimeout(timer); resolve(); }
      }, 50);
    });

    const exitPromise = new Promise((resolve) => child.on('close', (code) => resolve(code)));
    child.kill('SIGINT');
    assert.equal(await exitPromise, 0);
    assert.match(out, /shutdown complete/);
  });
});

test('the production entry point is exactly "node src/server.js"', async () => {
  const pkg = JSON.parse(await fsp.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts.start, 'node src/server.js');
  assert.equal(pkg.main, 'src/server.js');

  const dockerfile = await fsp.readFile(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /CMD \["node", "src\/server\.js"\]/);
});
