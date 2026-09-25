'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildArchiveName,
  sanitizeEntryName,
  urlToEntryName,
  uniqueEntryName,
  assertInside,
  sanitizeHostname
} = require('../../src/utils/filename');

test('archive name is <hostname>-<suffix>.zip and always header-safe', () => {
  assert.equal(buildArchiveName('https://example.com/path', 'OnlyF!xaDev'), 'example-com-OnlyF!xaDev.zip');
  assert.equal(buildArchiveName('http://sub.domain.co.uk/', 'OnlyF!xaDev'), 'sub-domain-co-uk-OnlyF!xaDev.zip');
  assert.equal(buildArchiveName('not a url', 'OnlyF!xaDev'), 'site-OnlyF!xaDev.zip');
  const evil = buildArchiveName('https://example.com/', 'a"b;c\rd\ne');
  assert.ok(!/[";\r\n]/.test(evil), `header-injection chars leaked: ${evil}`);
});

test('sanitizeHostname keeps only safe characters', () => {
  assert.equal(sanitizeHostname('EXAMPLE.com'), 'example-com');
  assert.equal(sanitizeHostname('[::1]'), '1');
  assert.equal(sanitizeHostname(''), 'site');
});

test('zip-slip: ".." segments cannot escape', () => {
  for (const raw of ['../../../etc/passwd', '..\\..\\windows\\system32', '/../../x', 'a/../../b']) {
    const out = sanitizeEntryName(raw);
    assert.ok(!out.includes('..'), `${raw} -> ${out}`);
    assert.ok(!out.startsWith('/'), `${raw} -> ${out}`);
  }
  assert.equal(sanitizeEntryName('../../etc/passwd'), 'etc/passwd');
});

test('null bytes, control chars and windows-illegal chars are removed', () => {
  assert.ok(!sanitizeEntryName('a\u0000b.txt').includes('\u0000'));
  assert.equal(sanitizeEntryName('a<b>c:d|e?f*g.txt'), 'a_b_c_d_e_f_g.txt');
  assert.ok(!/[\u0000-\u001f]/.test(sanitizeEntryName('we\u0001ird\u007f.txt')));
});

test('reserved windows device names are neutralised', () => {
  assert.equal(sanitizeEntryName('CON'), '_CON');
  assert.equal(sanitizeEntryName('nul.txt'), '_nul.txt');
  assert.equal(sanitizeEntryName('dir/COM1'), 'dir/_COM1');
});

test('empty or dot-only names fall back to index.html', () => {
  assert.equal(sanitizeEntryName(''), 'index.html');
  assert.equal(sanitizeEntryName('.'), 'index.html');
  assert.equal(sanitizeEntryName('..'), 'index.html');
  assert.equal(sanitizeEntryName('///'), 'index.html');
});

test('url -> archive entry path', () => {
  assert.equal(urlToEntryName('https://a.com/'), 'index.html');
  assert.equal(urlToEntryName('https://a.com/about'), 'about/index.html');
  assert.equal(urlToEntryName('https://a.com/about/'), 'about/index.html');
  assert.equal(urlToEntryName('https://a.com/css/app.css'), 'css/app.css');
  assert.equal(urlToEntryName('https://a.com/x?y=1#z'), 'x/index.html');
  assert.equal(urlToEntryName('https://a.com/%7Euser/page.html'), '~user/page.html');
  // ".." is neutralised, and an extensionless segment is treated as a route.
  assert.equal(urlToEntryName('https://a.com/../../etc/passwd'), 'etc/passwd/index.html');
});

test('colliding entry names are de-duplicated deterministically', () => {
  const used = new Set();
  assert.equal(uniqueEntryName('a.html', used), 'a.html');
  assert.equal(uniqueEntryName('a.html', used), 'a-2.html');
  assert.equal(uniqueEntryName('a.html', used), 'a-3.html');
});

test('assertInside refuses paths outside the job directory', () => {
  const root = '/tmp/webzip/job1';
  assert.equal(assertInside(root, '/tmp/webzip/job1/files/a.css'), '/tmp/webzip/job1/files/a.css');
  assert.throws(() => assertInside(root, '/tmp/webzip/job2/a.css'), /outside the job directory/);
  assert.throws(() => assertInside(root, '/tmp/webzip/job1/../../etc/passwd'), /outside the job directory/);
  assert.throws(() => assertInside(root, '/etc/passwd'), /outside the job directory/);
});
