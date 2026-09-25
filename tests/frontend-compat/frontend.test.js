'use strict';

/**
 * tests/frontend-compat/frontend.test.js
 *
 * The acceptance gate from Section J: the EXISTING index.html, loaded
 * unmodified, must complete a full archive-and-download cycle.
 *
 * This extracts the real <script> block out of index.html and executes it in a
 * VM with a minimal DOM, against the real running backend. It drives the
 * shipped frontend code — not a re-implementation of it.
 *
 * Limitation, stated plainly: this is not a real headless browser (no Chromium
 * in the sandbox), so it proves the script's logic, network contract and DOM
 * writes, not CSS layout or real anchor-download behaviour.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { startTestServer } = require('../helpers/start');
const { startFixtureSite } = require('../helpers/fixture-site');

const INDEX_HTML = path.resolve(__dirname, '..', '..', 'index.html');

function extractFrontendScript() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'index.html must contain an inline <script> block');
  return match[1];
}

function makeElement(id, recorder) {
  const classes = new Set();
  return {
    id,
    value: '',
    textContent: '',
    innerHTML: '',
    href: '',
    download: '',
    disabled: false,
    style: {},
    children: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c)
    },
    addEventListener: (type) => recorder.listeners.push({ id, type }),
    appendChild: (child) => recorder.elements(id).children.push(child),
    remove: () => {},
    click: () => { recorder.clicked[id] = (recorder.clicked[id] || 0) + 1; },
    setAttribute: () => {}
  };
}

function createDom() {
  const recorder = {
    els: new Map(),
    listeners: [],
    clicked: {},
    toasts: [],
    blobs: [],
    elements(id) {
      if (!recorder.els.has(id)) recorder.els.set(id, makeElement(id, recorder));
      return recorder.els.get(id);
    }
  };

  const document = {
    getElementById: (id) => recorder.elements(id),
    createElement: () => makeElement('#created', recorder),
    addEventListener: (type) => recorder.listeners.push({ id: 'document', type }),
    body: { setAttribute: () => {}, style: {} }
  };

  return { document, recorder };
}

function runFrontend({ origin }) {
  const { document, recorder } = createDom();
  const timers = new Set();

  // Wrappers must actually invoke the frontend's own callback — otherwise the
  // 300ms "show result + toast" step never runs and the test proves nothing.
  const wrapTimeout = (hostFn) => (callback, ms, ...args) => {
    const handle = hostFn((...a) => {
      timers.delete(handle);
      if (typeof callback === 'function') callback(...a);
    }, ms, ...args);
    timers.add(handle);
    return handle;
  };
  const wrapInterval = (hostFn) => (callback, ms, ...args) => {
    const handle = hostFn((...a) => {
      if (typeof callback === 'function') callback(...a);
    }, ms, ...args);
    timers.add(handle);
    return handle;
  };

  const sandbox = {
    document,
    window: { location: { origin } },
    localStorage: { getItem: () => null, setItem: () => {} },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    console,
    URL: {
      createObjectURL: (blob) => { recorder.blobs.push(blob); return `blob:mock/${recorder.blobs.length}`; },
      revokeObjectURL: () => {}
    },
    Blob,
    fetch: (url, init) => {
      recorder.lastFetch = { url, init };
      return fetch(url, init);
    },
    setTimeout: wrapTimeout(setTimeout),
    setInterval: wrapInterval(setInterval),
    clearTimeout: (t) => { timers.delete(t); clearTimeout(t); },
    clearInterval: (t) => { timers.delete(t); clearInterval(t); }
  };

  // toast() builds its own element and appends it; intercept for assertions.
  const originalCreate = document.createElement;
  document.createElement = () => {
    const el = originalCreate();
    const descriptor = { className: '', textContent: '' };
    Object.defineProperty(el, 'className', {
      get: () => descriptor.className,
      set: (v) => { descriptor.className = v; }
    });
    Object.defineProperty(el, 'textContent', {
      get: () => descriptor.textContent,
      set: (v) => { descriptor.textContent = v; recorder.toasts.push({ text: v, className: descriptor.className }); }
    });
    return el;
  };

  const context = vm.createContext(sandbox);
  vm.runInContext(extractFrontendScript(), context, { filename: 'index.html:inline-script' });

  return { context, recorder, clearTimers: () => { for (const t of timers) { clearTimeout(t); clearInterval(t); } timers.clear(); } };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('the untouched frontend completes a full archive + download cycle', async (t) => {
  const site = await startFixtureSite();
  const ctx = await startTestServer({ extraAllowedPorts: [site.port], overrides: { RATE_LIMIT_MAX: '100' } });
  t.after(async () => { await ctx.close(); await site.close(); });

  const { context, recorder, clearTimers } = runFrontend({ origin: ctx.origin });
  t.after(clearTimers);

  recorder.elements('url-input').value = `${site.origin}/`;
  await vm.runInContext('downloadZip()', context);
  await wait(600);

  // 1. it called the documented endpoint on the same origin
  assert.equal(recorder.lastFetch.url, `${ctx.origin}/api/zip`);
  assert.equal(recorder.lastFetch.init.method, 'POST');
  assert.deepEqual(JSON.parse(recorder.lastFetch.init.body), { url: `${site.origin}/` });

  // 2. the success toast fired with the server-generated filename
  const expectedName = `127-0-0-1-${ctx.config.filenameSuffix}.zip`;
  const ok = recorder.toasts.find((x) => x.className.includes('ok'));
  assert.ok(ok, `no success toast; got ${JSON.stringify(recorder.toasts)}`);
  assert.equal(ok.text, `✓ ${expectedName} ready!`);

  // 3. the result card shows the name + size taken from the response
  assert.equal(recorder.elements('result-name').textContent, expectedName);
  assert.match(recorder.elements('result-size').textContent, /MB · application\/zip/);

  // 4. the download anchor was populated and auto-clicked
  assert.equal(recorder.elements('dl-btn').download, expectedName);
  assert.match(recorder.elements('dl-btn').href, /^blob:mock\//);
  assert.equal(recorder.clicked['dl-btn'], 1);

  // 5. the bytes the browser received are a real ZIP
  const blob = recorder.blobs.at(-1);
  assert.ok(blob && blob.size > 0, 'no blob captured');
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04]);

  // 6. UI state: spinner hidden, result shown
  assert.equal(recorder.elements('status-wrap').classList.contains('show'), false);
  assert.equal(recorder.elements('result-wrap').classList.contains('show'), true);
});

test('a rejected URL surfaces a readable toast (not "Error: true")', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const { context, recorder, clearTimers } = runFrontend({ origin: ctx.origin });
  t.after(clearTimers);

  recorder.elements('url-input').value = 'http://10.0.0.5/';
  await vm.runInContext('downloadZip()', context);
  await wait(200);

  const err = recorder.toasts.find((x) => x.className.includes('err'));
  assert.ok(err, `no error toast; got ${JSON.stringify(recorder.toasts)}`);
  assert.match(err.text, /^Error: That address is in a blocked network range\./);
  assert.doesNotMatch(err.text, /Error: true/, 'a boolean `error` field would render as "Error: true"');

  // the button is re-enabled and the spinner hidden after a failure
  assert.equal(recorder.elements('zip-btn').disabled, false);
  assert.equal(recorder.elements('status-wrap').classList.contains('show'), false);
});

test('an empty input is rejected client-side without a request', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const { context, recorder, clearTimers } = runFrontend({ origin: ctx.origin });
  t.after(clearTimers);

  recorder.elements('url-input').value = '   ';
  await vm.runInContext('downloadZip()', context);
  await wait(50);

  assert.equal(recorder.lastFetch, undefined, 'no network call should be made');
  assert.equal(recorder.toasts.at(-1).text, 'Please enter a website URL.');
});

test('the frontend adds https:// when the scheme is missing', async (t) => {
  const ctx = await startTestServer();
  t.after(() => ctx.close());

  const { context, recorder, clearTimers } = runFrontend({ origin: ctx.origin });
  t.after(clearTimers);

  recorder.elements('url-input').value = 'example.com';
  await vm.runInContext('downloadZip()', context);
  await wait(200);

  assert.deepEqual(JSON.parse(recorder.lastFetch.init.body), { url: 'https://example.com' });
});
