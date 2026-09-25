'use strict';

/**
 * utils/timeout.js — promise-with-timeout helpers.
 * `withTimeout` always settles exactly once and lets the caller clean up the
 * timer, so a finished job never keeps the event loop alive.
 */

const { TimeoutError } = require('./errors');

/**
 * Rejects with `errorFactory()` after `ms`. The wrapped promise keeps running
 * (JS can't cancel it) — callers must make the underlying work abortable
 * (AbortController) and pass it in via `onTimeout`.
 */
function withTimeout(promise, ms, errorFactory = () => new TimeoutError(), onTimeout = null) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch (_) { /* cleanup must not mask the timeout */ }
      reject(errorFactory());
    }, ms);
    // Deliberately NOT unref'd: an unref'd timer can be skipped when the loop
    // drains, which would silently drop a job timeout. It is always cleared in
    // the finally() below, so it never outlives the race.
  });

  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

module.exports = { withTimeout };
