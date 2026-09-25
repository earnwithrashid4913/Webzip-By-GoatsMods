'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRateLimiter } = require('../../src/security/rate-limiter');
const { RateLimitError } = require('../../src/utils/errors');
const { createSemaphore } = require('../../src/services/job-service');
const { ArchiveStartError } = require('../../src/utils/errors');

test('allows up to RATE_LIMIT_MAX per window, then 429', () => {
  const rl = createRateLimiter({ windowMs: 60000, max: 3 });
  assert.equal(rl.check('1.2.3.4').remaining, 2);
  assert.equal(rl.check('1.2.3.4').remaining, 1);
  assert.equal(rl.check('1.2.3.4').remaining, 0);
  assert.throws(() => rl.check('1.2.3.4'), (err) => {
    assert.ok(err instanceof RateLimitError);
    assert.equal(err.httpStatus, 429);
    assert.equal(err.code, 'RATE_LIMITED');
    assert.ok(err.retryAfterMs > 0);
    return true;
  });
  rl.close();
});

test('ips are tracked independently', () => {
  const rl = createRateLimiter({ windowMs: 60000, max: 1 });
  rl.check('1.1.1.1');
  assert.doesNotThrow(() => rl.check('2.2.2.2'));
  assert.equal(rl.stats().trackedIps, 2);
  rl.close();
});

test('the window slides: old hits expire', async () => {
  const rl = createRateLimiter({ windowMs: 60, max: 1 });
  rl.check('9.9.9.9');
  assert.throws(() => rl.check('9.9.9.9'));
  await new Promise((r) => setTimeout(r, 90));
  assert.doesNotThrow(() => rl.check('9.9.9.9'));
  rl.close();
});

test('semaphore: admits up to max, then queues, then promotes a waiter', async () => {
  const sem = createSemaphore(2, 500);
  const r1 = await sem.acquire();
  const r2 = await sem.acquire();
  assert.equal(sem.stats().active, 2);

  const queued = sem.acquire(); // no slot free -> waits in the admission queue
  assert.equal(sem.stats().queued, 1);

  r1(); // freeing a slot promotes the queued waiter
  const r3 = await queued;
  assert.equal(sem.stats().active, 2);
  assert.equal(sem.stats().queued, 0);

  r2();
  r3();
  assert.equal(sem.stats().active, 0);
});

test('semaphore: a waiter that never gets a slot rejects with 502', async () => {
  const sem = createSemaphore(1, 40);
  const release = await sem.acquire();

  await assert.rejects(sem.acquire(), (err) => {
    assert.ok(err instanceof ArchiveStartError);
    assert.equal(err.httpStatus, 502);
    assert.equal(err.code, 'ARCHIVE_START_FAILED');
    assert.match(err.message, /at capacity/);
    return true;
  });

  assert.equal(sem.stats().queued, 0, 'a timed-out waiter must leave the queue');
  release();
  assert.equal(sem.stats().active, 0);
});

test('semaphore: zero admission timeout rejects immediately at capacity', async () => {
  const sem = createSemaphore(1, 0);
  const release = await sem.acquire();
  await assert.rejects(sem.acquire(), /at capacity/);
  release();
});
