'use strict';

/**
 * server.js — boots Express, wires middleware, serves the untouched
 * index.html, and owns graceful shutdown.
 *
 * Startup command (Docker + Pterodactyl egg): `node src/server.js`
 */

const http = require('node:http');
const path = require('node:path');
const express = require('express');

const { loadConfig, loadEnvFiles } = require('./config/config');
const { createLogger } = require('./utils/logger');
const { createCleanupService } = require('./services/cleanup-service');
const { createJobService } = require('./services/job-service');
const { createRateLimiter } = require('./security/rate-limiter');
const { jsonBodyLimit, applyServerTimeouts, securityHeaders } = require('./security/request-limits');
const { requestId } = require('./middleware/request-id');
const { createErrorHandler, notFoundHandler } = require('./middleware/error-handler');
const { createZipController } = require('./controllers/zip-controller');
const { createHealthController } = require('./controllers/health-controller');
const { createApiRouter } = require('./routes/api');
const { createHealthRouter } = require('./routes/health');

const FRONTEND_FILE = path.resolve(__dirname, '..', 'index.html');
// Exposed so the TEMP_DIR safety check can prove the frontend is not inside it.
process.env.WEBZIP_FRONTEND_FILE = process.env.WEBZIP_FRONTEND_FILE || FRONTEND_FILE;

function buildApp({ config, logger }) {
  let jobService = null;

  const cleanup = createCleanupService({
    config,
    logger,
    isJobActive: (jobId) => (jobService ? jobService.isJobActive(jobId) : false)
  });

  // Fail fast: a TEMP_DIR that holds the app would be wiped by the boot sweep.
  cleanup.assertSafeTempDir(config.tempDir);
  jobService = createJobService({ config, logger, cleanup });

  const rateLimiter = createRateLimiter({
    windowMs: config.rateLimitWindowMs,
    max: config.rateLimitMax,
    logger
  });

  const healthController = createHealthController({ jobService });
  const zipController = createZipController({ config, logger, jobService });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  app.use(securityHeaders);
  app.use(requestId());

  // Access log: no bodies, no headers, no cookies — and URLs are redacted.
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      logger?.info?.({
        requestId: req.requestId,
        method: req.method,
        // req.path is router-relative inside a mounted router ("/" for /api/zip);
        // originalUrl is the real request target. The query string is dropped so
        // it can never leak a URL parameter into the logs.
        path: (req.originalUrl || req.url || '/').split('?')[0],
        status: res.statusCode,
        ms: Date.now() - started
      }, 'request');
    });
    next();
  });

  // Rate limiting sits in front of the archive controller only, so health
  // probes and the static page are never throttled.
  app.use('/api/zip', rateLimiter.middleware);

  // The frontend contract: exactly two things are publicly served —
  // the root page and /api/zip. Source files are never exposed.
  app.get(['/', '/index.html'], (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(FRONTEND_FILE);
  });

  app.use('/api', createApiRouter({ zipController, healthController, jsonBodyLimitMiddleware: jsonBodyLimit(config.requestBodyLimit) }));
  app.use('/health', createHealthRouter({ healthController }));

  app.use(notFoundHandler);
  app.use(createErrorHandler({ logger }));

  return { app, jobService, cleanup, rateLimiter };
}

async function startServer({ config = loadConfig(), logger = createLogger({ level: config.logLevel }) } = {}) {
  const { app, jobService, cleanup, rateLimiter } = buildApp({ config, logger });

  await cleanup.ensureTempRoot();
  const orphaned = await cleanup.sweepOrphansOnBoot();

  const server = applyServerTimeouts(http.createServer(app), { jobTimeoutMs: config.jobTimeoutMs });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  cleanup.startPeriodicSweep();

  const address = server.address();
  logger.info({
    port: address.port,
    host: address.host,
    env: config.nodeEnv,
    tempDir: config.tempDir,
    maxConcurrentJobs: config.maxConcurrentJobs,
    jobTimeoutMs: config.jobTimeoutMs,
    orphanedDirsRemoved: orphaned,
    ssrfAllowLoopback: config.ssrfAllowLoopback
  }, 'WebZip backend listening');

  let closing = null;
  async function close() {
    if (closing) return closing;
    closing = (async () => {
      logger?.info?.('shutting down: draining in-flight jobs');
      cleanup.stopPeriodicSweep();
      rateLimiter.close();

      await new Promise((resolve) => {
        const force = setTimeout(() => {
          server.closeAllConnections?.();
          resolve();
        }, Math.min(config.jobTimeoutMs, 30000));
        // Deliberately ref-ed: an unref-ed timer can be skipped once the loop
        // drains, which would hang the shutdown forever.
        server.close(() => { clearTimeout(force); resolve(); });
        server.closeIdleConnections?.();
      });

      await jobService.shutdown();
      logger?.info?.('shutdown complete');
    })();
    return closing;
  }

  return { app, server, jobService, cleanup, rateLimiter, config, logger, close };
}

/**
 * Last-resort guards. They log loudly and exit with a clear code so the process
 * manager (Pterodactyl / Docker) restarts a clean instance. Never swallow these:
 * a corrupted in-memory job registry is worse than a restart.
 *
 * Exported so the tests can exercise the real production path in a child
 * process instead of trusting an untested handler.
 */
function installProcessGuards() {
  process.on('unhandledRejection', (reason) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({
      level: 'fatal',
      msg: 'unhandledRejection',
      err: String((reason && reason.message) || reason)
    }));
    process.exit(1);
  });

  process.on('uncaughtException', (err) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ level: 'fatal', msg: 'uncaughtException', err: err.message, stack: err.stack }));
    process.exit(1);
  });
}

/** SIGTERM/SIGINT -> drain in-flight jobs, clean up, exit 0. */
function installSignalHandlers(getRuntime) {
  const shutdown = async (signal) => {
    const runtime = getRuntime();
    runtime?.logger?.info?.({ signal }, 'signal received');
    try {
      await runtime?.close?.();
      process.exit(0);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ level: 'fatal', msg: 'shutdown failed', err: err.message }));
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  return shutdown;
}

if (require.main === module) {
  let runtime = null;

  installProcessGuards();
  installSignalHandlers(() => runtime);

  // Panel/host variables win; .env.production / .env only fill in the gaps.
  const envFiles = loadEnvFiles();

  startServer()
    .then((r) => {
      runtime = r;
      if (envFiles.length) r.logger?.info?.({ envFiles }, 'environment files loaded');
    })
    .catch((err) => {
      // Config errors must be loud and fatal - one process, one clear exit code.
      // eslint-disable-next-line no-console
      console.error(JSON.stringify({ level: 'fatal', msg: 'startup failed', err: err.message }));
      process.exit(1);
    });
}

module.exports = { startServer, buildApp, installProcessGuards, installSignalHandlers, FRONTEND_FILE };
