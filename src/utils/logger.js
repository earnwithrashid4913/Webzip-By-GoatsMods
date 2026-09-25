'use strict';

/**
 * utils/logger.js — structured JSON logging (pino).
 *
 * Policy from Section I: log requestId, jobId, sourceUrl (redacted), duration,
 * status, memory snapshot. Never log bodies, headers, cookies or auth data.
 */

const pino = require('pino');

const REDACTED_PARAMS = new Set([
  'token', 'access_token', 'accesstoken', 'api_key', 'apikey', 'key', 'secret',
  'password', 'passwd', 'pwd', 'auth', 'authorization', 'session', 'sessionid',
  'sid', 'signature', 'sig', 'code', 'otp', 'jwt', 'refresh_token'
]);

/** Strips sensitive query params from a URL before it ever reaches a log line. */
function redactUrl(input) {
  if (typeof input !== 'string' || !input) return input;
  try {
    const u = new URL(input);
    for (const k of [...u.searchParams.keys()]) {
      if (REDACTED_PARAMS.has(k.toLowerCase())) u.searchParams.set(k, '[redacted]');
    }
    u.username = '';
    u.password = '';
    return u.toString();
  } catch (_) {
    return '[unparseable-url]';
  }
}

function memorySnapshot() {
  const m = process.memoryUsage();
  return { rssMb: +(m.rss / 1048576).toFixed(1), heapUsedMb: +(m.heapUsed / 1048576).toFixed(1) };
}

let root = null;

function createLogger({ level = 'info' } = {}) {
  root = pino({
    level,
    base: { service: 'webzip' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label })
    }
  });
  return root;
}

module.exports = { createLogger, redactUrl, memorySnapshot };
