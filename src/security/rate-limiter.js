'use strict';

/**
 * security/rate-limiter.js — per-IP sliding window, in-process memory.
 * Redis-optional by design: only `check`/`stats`/`reset` are used elsewhere, so
 * a Redis-backed store can be dropped in without touching routes or services.
 */

const { RateLimitError } = require('../utils/errors');

function createRateLimiter({ windowMs, max, logger, pruneIntervalMs = 60000 }) {
  /** @type {Map<string, number[]>} */
  const hits = new Map();

  function prune(now = Date.now()) {
    const cutoff = now - windowMs;
    for (const [ip, times] of hits) {
      const kept = times.filter((t) => t > cutoff);
      if (kept.length) hits.set(ip, kept);
      else hits.delete(ip);
    }
  }

  function check(ip) {
    const now = Date.now();
    const cutoff = now - windowMs;
    const times = (hits.get(ip) || []).filter((t) => t > cutoff);

    if (times.length >= max) {
      const retryAfterMs = times[0] + windowMs - now;
      const err = new RateLimitError(
        `Too many requests. Try again in ${Math.ceil(retryAfterMs / 1000)}s.`
      );
      err.retryAfterMs = Math.max(1000, retryAfterMs);
      logger?.warn?.({ ip, windowMs, max }, 'rate limit hit');
      throw err;
    }

    times.push(now);
    hits.set(ip, times);
    return { remaining: Math.max(0, max - times.length) };
  }

  const timer = setInterval(prune, pruneIntervalMs);
  timer.unref?.();

  return {
    check,
    middleware: (req, _res, next) => {
      try {
        const { remaining } = check(req.ip || 'unknown');
        req.rateLimitRemaining = remaining;
        next();
      } catch (err) {
        next(err);
      }
    },
    stats: () => ({ trackedIps: hits.size }),
    reset: () => hits.clear(),
    close: () => clearInterval(timer)
  };
}

module.exports = { createRateLimiter };
