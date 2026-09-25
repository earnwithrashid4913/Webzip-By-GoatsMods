'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { loadConfig } = require('../../src/config/config');
const { validateUrl } = require('../../src/security/url-validator');
const { ValidationError } = require('../../src/utils/errors');

const config = loadConfig({ NODE_ENV: 'test', ALLOWED_PORTS: '80,443' });

function expectReject(value, match) {
  assert.throws(() => validateUrl(value, config), (err) => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err.name}`);
    assert.equal(err.httpStatus, 400);
    assert.equal(err.code, 'INVALID_URL');
    if (match) assert.match(err.message, match);
    return true;
  });
}

test('accepts a plain https URL and normalises it', () => {
  const { urlString, hostname, port } = validateUrl('https://example.com', config);
  assert.equal(urlString, 'https://example.com/');
  assert.equal(hostname, 'example.com');
  assert.equal(port, 443);
});

test('accepts an explicit allowed port', () => {
  const { port } = validateUrl('http://example.com:8080/', loadConfig({ NODE_ENV: 'test', ALLOWED_PORTS: '80,443,8080' }));
  assert.equal(port, 8080);
});

test('400: missing url', () => expectReject(undefined, /required/));
test('400: empty string', () => expectReject('   ', /required/));
test('400: not a url', () => expectReject('not a url', /valid http/));
test('400: unsupported protocol ftp', () => expectReject('ftp://example.com', /Unsupported protocol/));
test('400: unsupported protocol file', () => expectReject('file:///etc/passwd', /Unsupported protocol/));
test('400: unsupported protocol gopher', () => expectReject('gopher://example.com', /Unsupported protocol/));
test('400: unsupported protocol data', () => expectReject('data:text/html,hi', /Unsupported protocol/));

test('400: embedded credentials', () => expectReject('https://user:pass@example.com', /credentials/));
test('400: control characters', () => expectReject('https://example.com/\u0000x', /control characters/));
test('400: whitespace inside the host', () => expectReject('https://exa mple.com/', /valid http/));

test('400: localhost by name', () => expectReject('http://localhost', /Localhost/));
test('400: *.localhost', () => expectReject('http://db.localhost', /Localhost/));
test('400: loopback ip (flag off)', () => expectReject('http://127.0.0.1', /blocked network range/));
test('400: cloud metadata ip', () => expectReject('http://169.254.169.254/latest/meta-data/', /blocked network range/));
test('400: private ip', () => expectReject('http://10.0.0.5/', /blocked network range/));
test('400: IPv6 loopback', () => expectReject('http://[::1]/', /blocked network range/));
test('400: decimal-encoded loopback', () => expectReject('http://2130706433/', /blocked network range/));
test('400: metadata hostname', () => expectReject('http://metadata.google.internal/', /not allowed/));

test('400: port outside the allowlist (implicit 80)', () => {
  const strict = loadConfig({ NODE_ENV: 'test', ALLOWED_PORTS: '443' });
  assert.throws(() => validateUrl('http://example.com/', strict), /not in the allowlist/);
});

test('SSRF_ALLOW_LOOPBACK permits loopback but not link-local/private', () => {
  const testCfg = loadConfig({ NODE_ENV: 'test', SSRF_ALLOW_LOOPBACK: 'true' });
  assert.doesNotThrow(() => validateUrl('http://127.0.0.1/', testCfg));
  assert.throws(() => validateUrl('http://169.254.169.254/', testCfg), /blocked network range/);
  assert.throws(() => validateUrl('http://10.0.0.5/', testCfg), /blocked network range/);
});

test('strips the fragment before archiving', () => {
  const { urlString } = validateUrl('https://example.com/page#section', config);
  assert.equal(urlString, 'https://example.com/page');
});
