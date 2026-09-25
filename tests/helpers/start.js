'use strict';

/**
 * tests/helpers/start.js — boots the real server (src/server.js) on a random
 * port with a throwaway TEMP_DIR.
 *
 * SSRF_ALLOW_LOOPBACK=true lets the crawler reach the 127.0.0.1 fixture.
 * It relaxes loopback ONLY: 10/8, 172.16/12, 192.168/16, 169.254/16 and the
 * IPv6 ranges stay blocked, which keeps the SSRF integration tests meaningful.
 */

const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fsp = require('node:fs/promises');

const { loadConfig } = require('../../src/config/config');
const { startServer } = require('../../src/server');
const { createLogger } = require('../../src/utils/logger');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function startTestServer({ extraAllowedPorts = [], overrides = {}, beforeStart = null } = {}) {
  const port = await getFreePort();
  const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'webzip-test-'));
  if (beforeStart) await beforeStart(tempDir, port);

  const config = loadConfig({
    NODE_ENV: 'test',
    PORT: String(port),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    TEMP_DIR: tempDir,
    SSRF_ALLOW_LOOPBACK: 'true',
    ALLOWED_PORTS: ['80', '443', String(port), ...extraAllowedPorts.map(String)].join(','),
    ...overrides
  });

  const logger = createLogger({ level: 'silent' });
  const runtime = await startServer({ config, logger });

  return {
    runtime,
    config,
    tempDir,
    origin: `http://127.0.0.1:${port}`,
    close: async () => {
      // Tests need no graceful drain window: drop the client's keep-alive
      // sockets so server.close() resolves instead of waiting on them.
      runtime.server.closeAllConnections?.();
      await runtime.close();
      await fsp.rm(tempDir, { recursive: true, force: true });
    }
  };
}

module.exports = { startTestServer, getFreePort };
