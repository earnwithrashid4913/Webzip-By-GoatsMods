'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');

const { loadConfig, DEFAULTS } = require('../../src/config/config');
const {
  ValidationError, ArchiveStartError, TimeoutError, InternalError, RateLimitError, AppError
} = require('../../src/utils/errors');
const { redactUrl } = require('../../src/utils/logger');
const { withTimeout } = require('../../src/utils/timeout');

test('defaults are tuned for the 300 MB / 700 MB Pterodactyl target', () => {
  const c = loadConfig({ NODE_ENV: 'test' });
  assert.equal(c.port, 3000);
  assert.equal(c.host, '0.0.0.0');

  // conservative crawl
  assert.equal(c.maxPages, 25);
  assert.equal(c.maxAssets, 150);
  assert.equal(c.maxDepth, 2);
  assert.equal(c.crossOriginPages, false);
  assert.equal(c.respectRobots, true);

  // sizes and time
  assert.equal(c.maxTotalSize, 104857600); // 100 MB
  assert.equal(c.maxFileSize, 10485760); // 10 MB
  assert.equal(c.requestTimeoutMs, 12000);
  assert.equal(c.jobTimeoutMs, 90000);
  assert.equal(c.maxRedirects, 5);
  assert.equal(c.maxUrlLength, 2048);

  // one archive at a time
  assert.equal(c.maxConcurrentJobs, 1);
  assert.equal(c.maxConcurrentDownloads, 3);

  // abuse control + resource guards
  assert.equal(c.rateLimitMax, 6);
  assert.equal(c.rateLimitWindowMs, 60000);
  assert.deepEqual(c.allowedPorts, [80, 443]);
  assert.equal(c.maxRssMb, 230);
  assert.equal(c.maxTempDiskMb, 400);
  assert.equal(c.requestBodyLimit, '16kb');
  assert.equal(c.trustProxy, 0);
  assert.equal(c.ssrfAllowLoopback, false);
  assert.equal(DEFAULTS.TEMP_DIR, '/tmp/webzip');
});

test('environment overrides are parsed and typed', () => {
  const c = loadConfig({
    NODE_ENV: 'test', PORT: '8080', MAX_PAGES: '5', RESPECT_ROBOTS: 'false',
    ALLOWED_PORTS: '80,443,8080', MAX_TOTAL_SIZE: '2048', MAX_FILE_SIZE: '1024',
    MAX_TEMP_DISK_MB: '100', TRUST_PROXY: '1'
  });
  assert.equal(c.port, 8080);
  assert.equal(c.maxPages, 5);
  assert.equal(c.respectRobots, false);
  assert.deepEqual(c.allowedPorts, [80, 443, 8080]);
  assert.equal(c.trustProxy, 1);
});

test('TRUST_PROXY: unbounded trust is refused at boot (IP spoofing)', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true' }), /refused.*spoof/i);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', TRUST_PROXY: '99' }), /hop count must be <= 5/);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'banana' }), /must be 0, a hop count/);
});

test('TRUST_PROXY: safe values are accepted', () => {
  assert.equal(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: '0' }).trustProxy, 0);
  assert.equal(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: '1' }).trustProxy, 1);
  assert.equal(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: 'loopback' }).trustProxy, 'loopback');
  assert.equal(loadConfig({ NODE_ENV: 'test', TRUST_PROXY: '10.0.0.0/8' }).trustProxy, '10.0.0.0/8');
});

test('temp-disk ceiling must fit the worst case of the size x concurrency', () => {
  assert.throws(
    () => loadConfig({
      NODE_ENV: 'test', MAX_TOTAL_SIZE: String(300 * 1048576), MAX_FILE_SIZE: '1024',
      MAX_CONCURRENT_JOBS: '2', MAX_TEMP_DISK_MB: '400'
    }),
    /exceeds MAX_TEMP_DISK_MB/
  );
  assert.doesNotThrow(() => loadConfig({
    NODE_ENV: 'test', MAX_TOTAL_SIZE: String(100 * 1048576), MAX_FILE_SIZE: '1024',
    MAX_CONCURRENT_JOBS: '1', MAX_TEMP_DISK_MB: '400'
  }));
});

test('invalid values fail at boot', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'test', PORT: 'abc' }), /PORT must be an integer/);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', MAX_PAGES: '-1' }), /MAX_PAGES must be between/);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', RESPECT_ROBOTS: 'maybe' }), /RESPECT_ROBOTS must be a boolean/);
  assert.throws(() => loadConfig({ NODE_ENV: 'test', ALLOWED_PORTS: '80,99999' }), /invalid port/);
  assert.throws(
    () => loadConfig({ NODE_ENV: 'test', MAX_TOTAL_SIZE: '1024', MAX_FILE_SIZE: '2048' }),
    /MAX_FILE_SIZE cannot be larger/
  );
});

test('the loopback escape hatch is refused in production', () => {
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', SSRF_ALLOW_LOOPBACK: 'true' }),
    /refused when NODE_ENV=production/
  );
  assert.doesNotThrow(() => loadConfig({ NODE_ENV: 'test', SSRF_ALLOW_LOOPBACK: 'true' }));
});

test('the filename suffix is sanitised for header use', () => {
  const c = loadConfig({ NODE_ENV: 'test', FILENAME_SUFFIX: 'Only F!xa"Dev' });
  assert.equal(c.filenameSuffix, 'OnlyF!xaDev');
});

test('error classes map onto the documented contract', () => {
  assert.equal(new ValidationError('x').httpStatus, 400);
  assert.equal(new ValidationError('x').code, 'INVALID_URL');
  assert.equal(new ArchiveStartError('x').httpStatus, 502);
  assert.equal(new ArchiveStartError('x').code, 'ARCHIVE_START_FAILED');
  assert.equal(new TimeoutError().httpStatus, 504);
  assert.equal(new TimeoutError().code, 'ZIP_NOT_READY');
  assert.equal(new InternalError().httpStatus, 500);
  assert.equal(new RateLimitError().httpStatus, 429);
  assert.ok(new ValidationError('x') instanceof AppError);
});

test('error JSON keeps the documented keys AND a usable `error` string', () => {
  const body = new ValidationError("The 'url' field is required and must be a valid http(s) URL.").toJSON('a1b2c3d4');
  assert.equal(body.code, 'INVALID_URL');
  assert.equal(body.message, body.error);
  assert.equal(body.requestId, 'a1b2c3d4');
  assert.equal(body.isError, true);
  // The untouched frontend does: new Error(err.error || 'HTTP ' + status)
  assert.equal(new Error(body.error || 'HTTP 400').message, body.message);
});

test('redactUrl strips credentials and sensitive query params', () => {
  assert.equal(
    redactUrl('https://user:pw@example.com/a?token=abc&q=keep'),
    'https://example.com/a?token=%5Bredacted%5D&q=keep'
  );
  assert.equal(redactUrl('https://example.com/?api_key=secret'), 'https://example.com/?api_key=%5Bredacted%5D');
  assert.equal(redactUrl('https://example.com/clean'), 'https://example.com/clean');
  assert.equal(redactUrl('not a url'), '[unparseable-url]');
});

test('withTimeout rejects with the mapped 504 and runs the abort hook', async () => {
  let aborted = false;
  await assert.rejects(
    withTimeout(new Promise(() => {}), 30, () => new TimeoutError(), () => { aborted = true; }),
    (err) => err.httpStatus === 504 && err.code === 'ZIP_NOT_READY'
  );
  assert.equal(aborted, true);
});

test('withTimeout resolves normally and cleans up its timer', async () => {
  const value = await withTimeout(Promise.resolve('ok'), 5000);
  assert.equal(value, 'ok');
});

test('TEMP_DIR that contains the application is refused (boot sweep would wipe it)', () => {
  const { createCleanupService } = require('../../src/services/cleanup-service');
  const cleanup = createCleanupService({
    config: { tempDir: process.cwd(), jobTimeoutMs: 1000, cleanupSweepIntervalMs: 1000 },
    logger: null
  });

  assert.throws(() => cleanup.assertSafeTempDir(process.cwd()), /working directory/);
  assert.throws(() => cleanup.assertSafeTempDir(path.resolve(process.cwd(), '..')), /working directory/);
  assert.throws(() => cleanup.assertSafeTempDir('/'), /filesystem root/);
  // a dedicated scratch directory is fine
  assert.equal(cleanup.assertSafeTempDir('/tmp/webzip-safe-check'), '/tmp/webzip-safe-check');
});

test('MAX_URL_LENGTH is honoured and SERVER_PORT works as a Pterodactyl fallback', () => {
  const a = loadConfig({ NODE_ENV: 'test', MAX_URL_LENGTH: '64' });
  assert.equal(a.maxUrlLength, 64);

  const b = loadConfig({ NODE_ENV: 'test', SERVER_PORT: '25577' });
  assert.equal(b.port, 25577, 'the Pterodactyl allocation port must be used when PORT is unset');

  const c = loadConfig({ NODE_ENV: 'test', PORT: '3111', SERVER_PORT: '25577' });
  assert.equal(c.port, 3111, 'an explicit PORT wins');
});

test('loadEnvFiles parses .env without overriding real environment variables', async (t) => {
  const { loadEnvFiles } = require('../../src/config/config');
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'webzip-env-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));

  await fsp.writeFile(path.join(dir, '.env.production'), 'MAX_PAGES=11\nFILENAME_SUFFIX="Prod Suffix"\n');
  await fsp.writeFile(path.join(dir, '.env'), [
    '# a comment',
    '',
    'export MAX_PAGES=99          # ignored: .env.production wins',
    'MAX_ASSETS=7',
    "EMPTY_VALUE=",
    "QUOTED='keep  # this hash'",
    'not a valid line',
    'USER_AGENT=WebZip/2.0   # trailing comment'
  ].join('\n'));

  const env = { NODE_ENV: 'production', MAX_ASSETS: '4242' }; // real env must win
  const loaded = loadEnvFiles({ cwd: dir, env });

  assert.equal(loaded.length, 2);
  assert.equal(env.MAX_PAGES, '11', '.env.production beats .env');
  assert.equal(env.MAX_ASSETS, '4242', 'a real environment variable is never overwritten');
  assert.equal(env.FILENAME_SUFFIX, 'Prod Suffix', 'double quotes are stripped');
  assert.equal(env.QUOTED, 'keep  # this hash', 'quoted values keep their # character');
  assert.equal(env.USER_AGENT, 'WebZip/2.0', 'trailing comments are stripped from bare values');
  assert.equal(env.EMPTY_VALUE, '', 'an empty value stays empty');
});

test('the shipped .env.production is valid and consistent with the config guards', () => {
  const { loadEnvFiles } = require('../../src/config/config');
  const repo = path.resolve(__dirname, '..', '..');

  const env = { NODE_ENV: 'production' };
  const loaded = loadEnvFiles({ cwd: repo, env });
  assert.ok(loaded.length >= 1, '.env.production must exist and be readable');

  assert.equal(env.MAX_CONCURRENT_JOBS, '1', 'one archive job at a time');
  assert.equal(env.SSRF_ALLOW_LOOPBACK, 'false');
  assert.equal(env.TRUST_PROXY, '0');

  // TEMP_DIR in the file points at the Pterodactyl server folder, which does
  // not exist in CI, so override it the way a real environment variable would.
  env.TEMP_DIR = '/tmp/webzip-recommended-check';

  const config = loadConfig(env); // throws if any boot cross-check fails
  assert.equal(config.maxConcurrentJobs, 1);
  assert.equal(config.maxTempDiskMb, 400);
  assert.equal(config.maxRssMb, 230);
  assert.equal(config.maxTotalSize, 104857600);
  assert.equal(config.port, 3000, 'an empty PORT falls back to the documented default');
  assert.ok(
    config.maxTotalSize * 2 * config.maxConcurrentJobs <= config.maxTempDiskMb * 1048576,
    'the recommended file must satisfy the temp-disk cross-check'
  );
});
