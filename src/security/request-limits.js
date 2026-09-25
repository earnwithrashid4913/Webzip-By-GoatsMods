'use strict';

/**
 * security/request-limits.js — body size, HTTP server timeouts and the mapping
 * of body-parser failures onto the documented 400 INVALID_URL contract.
 */

const express = require('express');
const { ValidationError } = require('../utils/errors');

function jsonBodyLimit(limit) {
  const parser = express.json({ limit, strict: true, type: ['application/json', 'application/*+json'] });

  return function parseJsonBody(req, res, next) {
    parser(req, res, (err) => {
      if (!err) return next();

      if (err.type === 'entity.too.large') {
        return next(new ValidationError(`Request body is too large (max ${limit}).`));
      }
      if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
        return next(new ValidationError('Request body must be valid JSON, e.g. { "url": "https://example.com" }.'));
      }
      if (err.type === 'charset.unsupported' || err.type === 'encoding.unsupported') {
        return next(new ValidationError('Unsupported request encoding.'));
      }
      return next(err);
    });
  };
}

/** Slow-loris / hung-connection protection at the socket level. */
function applyServerTimeouts(server, { jobTimeoutMs }) {
  server.headersTimeout = 20000;
  server.requestTimeout = jobTimeoutMs + 30000;
  server.keepAliveTimeout = 15000;
  server.timeout = jobTimeoutMs + 60000;
  return server;
}

/** Baseline security headers (helmet not needed for three headers). */
function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.removeHeader('X-Powered-By');
  next();
}

module.exports = { jsonBodyLimit, applyServerTimeouts, securityHeaders };
