'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractLinks, parseRobots } = require('../../src/services/crawler-service');

const BASE = 'https://site.example/page/';

test('extracts anchors, stylesheets, scripts, images, iframes', () => {
  const html = `
    <a href="/a">A</a>
    <a HREF='/b'>B</a>
    <a href=c>rel</a>
    <link rel="stylesheet" href="/css/app.css">
    <script src="/js/app.js"></script>
    <img src="/img/logo.png">
    <iframe src="/embed"></iframe>
  `;
  const { pageLinks, assetLinks } = extractLinks(html, BASE);

  assert.ok(pageLinks.includes('https://site.example/a'));
  assert.ok(pageLinks.includes('https://site.example/b'));
  assert.ok(pageLinks.includes('https://site.example/page/c'), 'relative href resolves against the page');
  assert.ok(assetLinks.includes('https://site.example/css/app.css'));
  assert.ok(assetLinks.includes('https://site.example/js/app.js'));
  assert.ok(assetLinks.includes('https://site.example/img/logo.png'));
  assert.ok(assetLinks.includes('https://site.example/embed'));
});

test('extracts srcset candidates', () => {
  const { assetLinks } = extractLinks('<img srcset="/a.png 1x, /b.png 2x">', BASE);
  assert.ok(assetLinks.includes('https://site.example/a.png'));
  assert.ok(assetLinks.includes('https://site.example/b.png'));
});

test('ignores javascript:, mailto:, data:, blob: and fragments', () => {
  const html = `
    <a href="javascript:alert(1)">x</a>
    <a href="mailto:a@b.c">mail</a>
    <a href="data:text/html,hi">data</a>
    <a href="blob:https://x/y">blob</a>
    <a href="tel:+123">tel</a>
    <a href="/ok#frag">ok</a>
  `;
  const { pageLinks } = extractLinks(html, BASE);
  assert.deepEqual(pageLinks, ['https://site.example/ok'], `got ${JSON.stringify(pageLinks)}`);
});

test('fragments are stripped so one page is not archived twice', () => {
  const { pageLinks } = extractLinks('<a href="/p#one">1</a><a href="/p#two">2</a>', BASE);
  assert.deepEqual(pageLinks, ['https://site.example/p']);
});

test('garbage markup does not throw', () => {
  assert.doesNotThrow(() => extractLinks('<a href="<a href=\'unclosed', BASE));
  assert.doesNotThrow(() => extractLinks('', BASE));
});

test('robots: disallow blocks, allow overrides by longest match', () => {
  const isAllowed = parseRobots([
    'User-agent: *',
    'Disallow: /private',
    'Allow: /private/public-page',
    '',
    'User-agent: badbot',
    'Disallow: /'
  ].join('\n'));

  assert.equal(isAllowed('/'), true);
  assert.equal(isAllowed('/about'), true);
  assert.equal(isAllowed('/private'), false);
  assert.equal(isAllowed('/private/secret'), false);
  assert.equal(isAllowed('/private/public-page'), true, 'longest match wins');
});

test('robots: user-agent specific groups are preferred over *', () => {
  const rules = 'User-agent: WebZip\nDisallow: /blocked\n\nUser-agent: *\nDisallow: /everything';
  const isAllowed = parseRobots(rules, 'webzip');
  assert.equal(isAllowed('/blocked'), false);
  assert.equal(isAllowed('/everything'), true, 'the * group must not apply once a UA group matches');
});

test('robots: "Disallow: /" blocks everything', () => {
  const isAllowed = parseRobots('User-agent: *\nDisallow: /');
  assert.equal(isAllowed('/anything'), false);
});

test('robots: empty or malformed file allows everything', () => {
  assert.equal(parseRobots('')('/x'), true);
  assert.equal(parseRobots('garbage without colons')('/x'), true);
  assert.equal(parseRobots('User-agent: *\nDisallow:')('/x'), true);
});
