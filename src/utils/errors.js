'use strict';

/**
 * utils/errors.js — typed error classes. Every one of them knows which of the
 * four documented HTTP codes it maps to, so the error handler never guesses.
 *
 * Contract (Section F): 400 INVALID_URL · 502 ARCHIVE_START_FAILED
 *                       504 ZIP_NOT_READY · 500 INTERNAL_ERROR
 *
 * NOTE ON THE JSON SHAPE: the architecture doc sketched `"error": true`.
 * The unchangeable frontend does:
 *     const err = await res.json().catch(() => ({}));
 *     throw new Error(err.error || 'HTTP ' + res.status);
 * With a boolean, the user would see the toast "Error: true". So `error`
 * carries the human-readable message (still truthy) and `isError` carries
 * the boolean. `code`, `message` and `requestId` are exactly as documented.
 */

class AppError extends Error {
  constructor(message, { code = 'INTERNAL_ERROR', httpStatus = 500, cause = null } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.httpStatus = httpStatus;
    this.expose = true; // safe to show to the client
    if (cause) this.cause = cause;
    Error.captureStackTrace?.(this, new.target);
  }

  toJSON(requestId) {
    return {
      error: this.message,
      isError: true,
      code: this.code,
      message: this.message,
      requestId: requestId || null
    };
  }
}

/** 400 — missing/malformed URL, unsupported scheme, or blocked by SSRF rules. */
class ValidationError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: 'INVALID_URL', httpStatus: 400, ...opts });
  }
}

/** 502 — job could not start: unreachable target, at capacity, instant crawl failure. */
class ArchiveStartError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: 'ARCHIVE_START_FAILED', httpStatus: 502, ...opts });
  }
}

/** 504 — job exceeded JOB_TIMEOUT_MS. Client should retry. */
class TimeoutError extends AppError {
  constructor(message = 'The archive was not ready in time. Please retry.', opts = {}) {
    super(message, { code: 'ZIP_NOT_READY', httpStatus: 504, ...opts });
  }
}

/** 500 — unexpected server-side failure. */
class InternalError extends AppError {
  constructor(message = 'Internal server error.', opts = {}) {
    super(message, { code: 'INTERNAL_ERROR', httpStatus: 500, ...opts });
  }
}

/**
 * 429 — the one response outside the four archive codes. The design doc keeps
 * rate limiting "handled separately from the four archive error codes".
 */
class RateLimitError extends AppError {
  constructor(message = 'Too many requests. Please slow down.', opts = {}) {
    super(message, { code: 'RATE_LIMITED', httpStatus: 429, ...opts });
  }
}

/**
 * 502 — the archive could not be COMPLETED within the configured limits.
 * A 200 must always mean a valid, complete archive, so hitting a page, asset,
 * file-size or total-size limit is reported as a failure instead of quietly
 * streaming a partial ZIP. Stays inside the four documented HTTP codes.
 */
class LimitsExceededError extends AppError {
  constructor(message, opts = {}) {
    super(message, { code: 'LIMITS_EXCEEDED', httpStatus: 502, ...opts });
  }
}

/** Aborted because a size cap was crossed mid-stream. Not an HTTP error. */
class SizeLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SizeLimitError';
    this.code = 'SIZE_LIMIT';
  }
}

/** A target that refused to behave (DNS, connection reset, bad status). */
class UpstreamError extends Error {
  constructor(message, { statusCode = null } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.code = 'UPSTREAM_ERROR';
    this.statusCode = statusCode;
  }
}

module.exports = {
  AppError,
  LimitsExceededError,
  ValidationError,
  ArchiveStartError,
  TimeoutError,
  InternalError,
  RateLimitError,
  SizeLimitError,
  UpstreamError
};
