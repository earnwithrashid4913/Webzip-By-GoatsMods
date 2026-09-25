'use strict';

/**
 * services/job-service.js — job lifecycle, state machine, registry, admission
 * control and the single place where cleanup can never be forgotten.
 *
 * One HTTP request == one job, held open end-to-end. The client never sees a
 * job id and never polls: this service awaits the job internally and hands the
 * controller a finished archive to stream.
 */

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { withTimeout } = require('../utils/timeout');
const { ArchiveStartError, LimitsExceededError, TimeoutError, UpstreamError, SizeLimitError } = require('../utils/errors');
const { memorySnapshot, redactUrl } = require('../utils/logger');
const { createSafeFetch } = require('../security/ssrf-protection');
const { createCrawler } = require('./crawler-service');
const { createAssetService } = require('./asset-service');
const { createZipService } = require('./zip-service');

const STATES = ['QUEUED', 'STARTING', 'CRAWLING', 'DOWNLOADING', 'PACKAGING', 'READY', 'FAILED', 'TIMEOUT'];

/** Counting semaphore with a short admission queue (Section E). */
function createSemaphore(max, admissionTimeoutMs) {
  let active = 0;
  const waiters = [];

  function release() {
    active -= 1;
    const next = waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      active += 1;
      next.resolve(release);
    }
  }

  function acquire() {
    if (active < max) {
      active += 1;
      return Promise.resolve(release);
    }
    if (!admissionTimeoutMs) {
      return Promise.reject(new ArchiveStartError('The archive service is at capacity. Please retry.'));
    }
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        const i = waiters.indexOf(entry);
        if (i !== -1) waiters.splice(i, 1);
        reject(new ArchiveStartError('The archive service is at capacity. Please retry.'));
      }, admissionTimeoutMs);
      // Not unref'd: this timer is the only thing that can settle the waiter.
      waiters.push(entry);
    });
  }

  return { acquire, stats: () => ({ active, queued: waiters.length, max }) };
}

function createJobService({ config, logger, cleanup }) {
  const safeFetch = createSafeFetch({ config, logger });
  const zipService = createZipService({ config, logger });
  const semaphore = createSemaphore(config.maxConcurrentJobs, config.admissionQueueTimeoutMs);
  /** @type {Map<string, object>} */
  const jobs = new Map();

  const isJobActive = (jobId) => jobs.has(jobId);

  function setState(job, state, extra) {
    job.state = state;
    job.updatedAt = Date.now();
    if (extra) Object.assign(job.progress, extra);
    logger?.debug?.({ jobId: job.id, state, ...extra }, 'job state');
  }

  async function storageUsedMb() {
    let bytes = 0;
    async function walk(dir) {
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch (_) {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await walk(p);
        else if (e.isFile()) {
          try { bytes += (await fsp.stat(p)).size; } catch (_) { /* raced with cleanup */ }
        }
      }
    }
    await walk(cleanup.root);
    return +(bytes / 1048576).toFixed(2);
  }

  async function runJob({ url, requestId, ip, signal }) {
    // RSS admission guard (Section E: refuse new jobs under memory pressure -> 502)
    if (config.maxRssMb > 0) {
      const rssMb = process.memoryUsage().rss / 1048576;
      if (rssMb > config.maxRssMb) {
        throw new ArchiveStartError('Server memory pressure is too high to start a new archive.');
      }
    }

    // Disk admission guard: refuse a new job when the temp volume is already
    // close to MAX_TEMP_DISK_MB, so repeated jobs can never fill the disk.
    const usedMb = await storageUsedMb();
    if (usedMb > config.maxTempDiskMb) {
      logger?.warn?.({ usedMb, maxTempDiskMb: config.maxTempDiskMb }, 'refusing job: temp disk pressure');
      throw new ArchiveStartError('Archive storage is full. Please retry in a moment.');
    }

    const release = await semaphore.acquire(); // throws 502 when at capacity
    const jobId = crypto.randomBytes(6).toString('hex');
    const controller = new AbortController();
    // A client disconnect (or any caller-side cancellation) must stop the crawl.
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
    const job = {
      id: jobId,
      requestId,
      ip,
      sourceUrl: url,
      state: 'QUEUED',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      progress: {}
    };
    jobs.set(jobId, job);

    const { dir: jobDir, filesDir } = await cleanup.createJobDir(jobId);
    let settled = false;
    let forceTimer = null;

    const finish = async () => {
      if (settled) return null;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      jobs.delete(jobId);
      // Awaited by the controller, so "cleaned up" means the directory is gone.
      return cleanup.removeJobDir(jobId);
    };

    try {
      setState(job, 'STARTING');
      const startedAt = Date.now();

      const pipeline = (async () => {
        const budget = { remaining: config.maxTotalSize };
        const usedNames = new Set();

        setState(job, 'CRAWLING');
        const crawler = createCrawler({ config, logger, safeFetch, filesDir, usedNames });
        const crawlResult = await crawler.crawl({
          startUrl: url,
          signal: controller.signal,
          budget,
          onState: (s, p) => setState(job, s, p)
        });

        setState(job, 'DOWNLOADING', { assets: crawlResult.assetUrls.length });
        const assets = createAssetService({ config, logger, safeFetch, filesDir, usedNames });
        const assetResult = await assets.downloadAll({
          urls: crawlResult.assetUrls,
          budget,
          signal: controller.signal,
          onState: (s, p) => setState(job, s, p)
        });

        // A 200 must mean a COMPLETE archive: if any configured limit cut the
        // job short, fail clearly instead of streaming a partial ZIP.
        const truncations = [...crawlResult.truncations, ...assetResult.truncations];
        if (truncations.length) {
          const shown = truncations.slice(0, 3).map((t) => `${t.limit} (${t.detail})`).join('; ');
          throw new LimitsExceededError(
            `This website is too large to archive within the configured limits: ${shown}.` +
            (truncations.length > 3 ? ` (+${truncations.length - 3} more)` : '')
          );
        }

        setState(job, 'PACKAGING');
        const files = [
          ...crawlResult.pages.map((p) => ({ diskPath: p.diskPath, entryName: p.entryName })),
          ...assetResult.files.map((f) => ({ diskPath: f.diskPath, entryName: f.entryName }))
        ];

        if (!files.length) {
          throw new ArchiveStartError('Nothing could be archived from that URL.');
        }

        const { zipPath, size, entries } = await zipService.createArchive({
          jobDir,
          files,
          comment: `WebZip archive of ${url}`,
          signal: controller.signal
        });

        const durationMs = Date.now() - startedAt;
        setState(job, 'READY', { entries, size });
        logger?.info?.({
          jobId, requestId, durationMs, entries, size,
          pages: crawlResult.stats.pages,
          assets: assetResult.stats.downloaded,
          skippedPages: crawlResult.stats.skippedPages,
          skippedAssets: assetResult.stats.skipped,
          sourceUrl: redactUrl(url),
          memory: memorySnapshot()
        }, 'job ready');

        return { zipPath, size, entries, stats: { ...crawlResult.stats, ...assetResult.stats, durationMs } };
      })();

      const result = await withTimeout(
        pipeline,
        config.jobTimeoutMs,
        () => new TimeoutError(),
        () => controller.abort()
      );

      // Safety net: if the caller never reports the response as finished, the
      // job directory is still reclaimed.
      forceTimer = setTimeout(() => { finish().catch(() => {}); }, config.jobTimeoutMs);
      forceTimer.unref?.();

      return {
        job,
        zipPath: result.zipPath,
        size: result.size,
        entries: result.entries,
        stats: result.stats,
        cleanup: finish
      };
    } catch (rawErr) {
      // Map non-contract internal errors onto the documented codes. A target
      // that refuses / DNS-fails / oversizes before anything is archived is a
      // 502 ("job could not start"), exactly as the API contract promises.
      let err = rawErr;
      if (rawErr.name === 'AbortError') {
        err = new ArchiveStartError('The archive was cancelled (client disconnected).', { cause: rawErr });
      } else if (rawErr instanceof UpstreamError) {
        err = new ArchiveStartError(`The target site could not be archived: ${rawErr.message}`, { cause: rawErr });
      } else if (rawErr instanceof SizeLimitError) {
        err = new ArchiveStartError('The site exceeded the configured size limit before anything could be archived.', { cause: rawErr });
      }

      setState(job, err instanceof TimeoutError ? 'TIMEOUT' : 'FAILED', { error: err.message });
      logger?.warn?.({
        jobId, requestId, state: job.state, err: err.message, code: err.code,
        sourceUrl: redactUrl(url)
      }, 'job failed');
      await finish();
      throw err;
    } finally {
      release();
    }
  }

  async function abortAll() {
    for (const job of jobs.values()) {
      job.state = 'FAILED';
    }
  }

  return {
    runJob,
    abortAll,
    isJobActive,
    STATES,
    stats: async () => ({
      activeJobs: jobs.size,
      maxConcurrentJobs: config.maxConcurrentJobs,
      queuedJobs: semaphore.stats().queued,
      storageUsedMb: await storageUsedMb()
    }),
    shutdown: async () => {
      await abortAll();
      await cleanup.removeAll();
      await safeFetch.close().catch(() => {});
    }
  };
}

module.exports = { createJobService, createSemaphore };
