'use strict';

/**
 * tests/unit/ssrf-rebinding.test.js — DNS rebinding.
 *
 * The attack: a hostname answers with a PUBLIC address at validation time and
 * with a PRIVATE address when the socket actually connects. The defence under
 * test is DNS pinning — the connection must reuse the validated IP and must
 * never resolve the name a second time.
 *
 * A hostile resolver is injected instead of needing a real hostile DNS server,
 * which keeps the test deterministic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createSafeFetch } = require('../../src/security/ssrf-protection');
const { validateUrl } = require('../../src/security/url-validator');
const { loadConfig } = require('../../src/config/config');
const { startFixtureSite } = require('../helpers/fixture-site');

test('rebinding defeated: the socket uses the validated pin, no second lookup', async (t) => {
  const site = await startFixtureSite();
  t.after(() => site.close());

  const config = loadConfig({
    NODE_ENV: 'test',
    SSRF_ALLOW_LOOPBACK: 'true',
    ALLOWED_PORTS: `80,443,${site.port}`
  });

  let resolutions = 0;
  const rebindingResolver = async () => {
    resolutions += 1;
    // First answer is harmless; every later answer is the metadata service —
    // exactly what a rebinding attacker would flip to at connect time.
    return resolutions === 1
      ? { ip: '127.0.0.1', family: 4 }
      : { ip: '169.254.169.254', family: 4 };
  };

  const safe = createSafeFetch({ config, resolve: rebindingResolver });
  t.after(() => safe.close());

  const res = await safe.fetchSafe(`http://rebind.test:${site.port}/`, {
    validate: (u) => validateUrl(u, config)
  });
  const body = await safe.readBodyLimited(res, 1048576);

  assert.match(body.toString('utf8'), /Fixture Home/, 'the request reached the pinned address');
  assert.equal(resolutions, 1, 'the name must be resolved exactly once — connect reuses the pin');
});

test('a resolver that approves a blocked address is overruled', async (t) => {
  const config = loadConfig({ NODE_ENV: 'test', ALLOWED_PORTS: '80,443' });

  const lyingResolver = async () => ({ ip: '169.254.169.254', family: 4 });
  const safe = createSafeFetch({ config, resolve: lyingResolver });
  t.after(() => safe.close());

  await assert.rejects(
    safe.fetchSafe('http://innocent-looking.example/', { validate: (u) => validateUrl(u, config) }),
    (err) => {
      assert.equal(err.code, 'INVALID_URL');
      assert.equal(err.httpStatus, 400);
      assert.match(err.message, /blocked address/);
      return true;
    }
  );
});

test('a resolver that returns no pin at all fails closed', async (t) => {
  const config = loadConfig({ NODE_ENV: 'test', ALLOWED_PORTS: '80,443' });
  const safe = createSafeFetch({ config, resolve: async () => null });
  t.after(() => safe.close());

  await assert.rejects(
    safe.fetchSafe('http://anything.example/', { validate: (u) => validateUrl(u, config) }),
    /blocked address/
  );
});

test('redirects are re-validated through the same pinning path', async (t) => {
  const site = await startFixtureSite();
  t.after(() => site.close());

  const config = loadConfig({
    NODE_ENV: 'test',
    SSRF_ALLOW_LOOPBACK: 'true',
    ALLOWED_PORTS: `80,443,${site.port}`
  });

  let resolutions = 0;
  const safe = createSafeFetch({
    config,
    resolve: async () => { resolutions += 1; return { ip: '127.0.0.1', family: 4 }; }
  });
  t.after(() => safe.close());

  // /redirect-private 302s to http://10.0.0.5/ which is a blocked range.
  await assert.rejects(
    safe.fetchSafe(`http://rebind.test:${site.port}/redirect-private`, {
      validate: (u) => validateUrl(u, config)
    }),
    (err) => {
      assert.equal(err.httpStatus, 400);
      assert.match(err.message, /blocked/i);
      return true;
    }
  );
  assert.ok(resolutions >= 1);
});

test('MAX_REDIRECTS caps a redirect loop', async (t) => {
  const site = await startFixtureSite();
  t.after(() => site.close());

  const config = loadConfig({
    NODE_ENV: 'test',
    SSRF_ALLOW_LOOPBACK: 'true',
    MAX_REDIRECTS: '2',
    ALLOWED_PORTS: `80,443,${site.port}`
  });

  const safe = createSafeFetch({ config, resolve: async () => ({ ip: '127.0.0.1', family: 4 }) });
  t.after(() => safe.close());

  await assert.rejects(
    safe.fetchSafe(`http://rebind.test:${site.port}/loop`, { validate: (u) => validateUrl(u, config) }),
    /Too many redirects/
  );
});
