'use strict';

/**
 * tests/helpers/fixture-site.js — a tiny local website used as the crawl
 * target. The sandbox has no outbound internet, so every integration test runs
 * against this instead of a real site.
 */

const http = require('node:http');

const PAGES = {
  '/': `<!doctype html><html><head>
      <title>Fixture Home</title>
      <link rel="stylesheet" href="/style.css">
      <script src="/script.js"></script>
    </head><body>
      <h1>Home</h1>
      <a href="/about">About</a>
      <a href="/private/secret">Secret (robots-blocked)</a>
      <a href="/dead-end">Broken</a>
      <img src="/logo.svg" alt="logo">
      <img srcset="/logo.svg 1x, /logo-2.svg 2x" alt="srcset">
      <a href="http://10.0.0.5/blocked-asset.js">Blocked asset</a>
      <a href="/big">3MB file</a>
    </body></html>`,
  '/about': '<!doctype html><html><body><h1>About</h1><a href="/">Home</a></body></html>',
  '/private/secret': '<!doctype html><html><body>SHOULD NEVER BE FETCHED</body></html>',
  '/dead-end': null // responds 500
};

const ASSETS = {
  '/style.css': { type: 'text/css', body: 'body{color:#123}\n' },
  '/script.js': { type: 'application/javascript', body: 'console.log("fixture");\n' },
  '/logo.svg': { type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
  '/logo-2.svg': { type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="2"/>' }
};

function startFixtureSite() {
  const hits = [];

  const server = http.createServer((req, res) => {
    const path = req.url.split('?')[0];
    hits.push(path);

    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nDisallow: /private\n');
      return;
    }
    if (path === '/redirect-private') {
      res.writeHead(302, { location: 'http://10.0.0.5/' });
      res.end();
      return;
    }
    if (path === '/loop') {
      res.writeHead(302, { location: '/loop' }); // redirect loop -> MAX_REDIRECTS
      res.end();
      return;
    }
    if (path === '/slow') {
      // Never responds — used for the JOB_TIMEOUT / 504 case.
      return;
    }
    if (path === '/big') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.alloc(3 * 1024 * 1024, 7));
      return;
    }
    if (path === '/links') {
      const links = Array.from({ length: 60 }, (_, i) => `<a href="/p/${i + 1}">p${i + 1}</a>`).join('');
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body>${links}</body></html>`);
      return;
    }
    if (path.startsWith('/p/')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><html><body>page ${path}</body></html>`);
      return;
    }
    if (path === '/dead-end') {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('boom');
      return;
    }
    if (Object.prototype.hasOwnProperty.call(PAGES, path)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(PAGES[path]);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(ASSETS, path)) {
      const a = ASSETS[path];
      res.writeHead(200, { 'content-type': a.type });
      res.end(a.body);
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        origin: `http://127.0.0.1:${port}`,
        hits,
        close: () => new Promise((r) => {
          server.closeAllConnections?.(); // drop keep-alive sockets from the client
          server.close(r);
        })
      });
    });
  });
}

module.exports = { startFixtureSite };
