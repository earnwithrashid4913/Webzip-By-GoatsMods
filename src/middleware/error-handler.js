'use strict';

const { AppError, InternalError } = require('../utils/errors');

/**
 * middleware/error-handler.js — maps every internal error onto the documented
 * contract: 400 INVALID_URL / 502 ARCHIVE_START_FAILED / 504 ZIP_NOT_READY /
 * 500 INTERNAL_ERROR (plus 429 RATE_LIMITED for the limiter, which the design
 * keeps outside the four archive codes).
 */

function notFoundHandler(req, res) {
  res.status(404).json({
    error: `No route for ${req.method} ${req.path}`,
    isError: true,
    code: 'NOT_FOUND',
    message: `No route for ${req.method} ${req.path}`,
    requestId: req.requestId || null
  });
}

function createErrorHandler({ logger }) {
  // eslint-disable-next-line no-unused-vars
  return function errorHandler(err, req, res, next) {
    if (res.headersSent) {
      res.destroy();
      return;
    }

    const known = err instanceof AppError ? err : null;
    const status = known ? known.httpStatus : 500;
    const code = known ? known.code : 'INTERNAL_ERROR';
    const message = known ? known.message : 'Internal server error.';

    if (!known) {
      logger?.error?.({ requestId: req.requestId, err: err.message, stack: err.stack }, 'unhandled error');
    } else if (status >= 500) {
      logger?.error?.({ requestId: req.requestId, code, err: err.message }, 'server error');
    } else {
      logger?.info?.({ requestId: req.requestId, code, status }, 'request rejected');
    }

    const body = known
      ? known.toJSON(req.requestId)
      : new InternalError().toJSON(req.requestId);

    if (err && err.retryAfterMs) {
      res.setHeader('Retry-After', String(Math.ceil(err.retryAfterMs / 1000)));
    }

    res.status(status).json(body);
  };
}

module.exports = { createErrorHandler, notFoundHandler };
