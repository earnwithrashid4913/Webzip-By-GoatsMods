'use strict';

/**
 * services/asset-service.js — per-asset download with a worker pool,
 * content-type/size checks, and a shared byte budget.
 * Nothing is buffered in RAM: every asset streams disk-ward through a byte cap.
 */

const path = require('node:path');
const fsp = require('node:fs/promises');
const pLimit = require('p-limit');

const { urlToEntryName, uniqueEntryName, assertInside } = require('../utils/filename');
const { validateUrl } = require('../security/url-validator');

/** Types we never archive even if a page links to them. */
const SKIPPED_TYPES = new Set(['multipart/mixed', 'multipart/alternative', 'message/rfc822']);

function createAssetService({ config, logger, safeFetch, filesDir, usedNames }) {
  const limit = pLimit(config.maxConcurrentDownloads);

  async function downloadOne(rawUrl, budget, signal) {
    if (budget.remaining <= 0) return { truncated: 'MAX_TOTAL_SIZE' };

    const { urlString } = validateUrl(rawUrl, config); // SSRF step 1–2 on every asset
    let res;
    try {
      res = await safeFetch.fetchSafe(urlString, { validate: (u) => validateUrl(u, config), signal, accept: '*/*' });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      logger?.debug?.({ rawUrl, err: err.message }, 'asset skipped');
      return { skipped: 'fetch', reason: err.message };
    }

    if (SKIPPED_TYPES.has(res.contentType)) {
      res.destroy();
      return { skipped: 'content-type', contentType: res.contentType };
    }

    const entryName = uniqueEntryName(urlToEntryName(res.url), usedNames);
    const diskPath = assertInside(filesDir, path.join(filesDir, entryName));
    await fsp.mkdir(path.dirname(diskPath), { recursive: true });

    // Reserve synchronously before any await: with MAX_CONCURRENT_DOWNLOADS > 1
    // a check-then-act on a shared budget would let workers overshoot the cap.
    const cap = Math.min(config.maxFileSize, Math.max(1, budget.remaining));
    budget.remaining -= cap;
    try {
      const { size } = await safeFetch.pipeBodyToFile(res, diskPath, cap, { signal });
      budget.remaining += cap - size; // refund the unused reservation
      return { url: res.url.toString(), entryName, diskPath, size, contentType: res.contentType };
    } catch (err) {
      budget.remaining += cap;
      if (err.name === 'AbortError') throw err;
      if (err.name === 'SizeLimitError') {
        logger?.info?.({ rawUrl, cap }, 'asset skipped: per-file size cap');
        return { truncated: 'MAX_FILE_SIZE', detail: `${rawUrl} exceeds ${cap} bytes` };
      }
      logger?.debug?.({ rawUrl, err: err.message }, 'asset write failed');
      return { skipped: 'write', reason: err.message };
    }
  }

  async function downloadAll({ urls, budget, signal, onState }) {
    const files = [];
    const skipped = [];
    const truncations = [];
    let done = 0;

    const tasks = urls.map((u) => limit(async () => {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const result = await downloadOne(u, budget, signal);
      done += 1;
      if (done % 25 === 0 || done === urls.length) onState?.('DOWNLOADING', { done, total: urls.length });
      if (result.truncated) truncations.push({ limit: result.truncated, detail: result.detail || u });
      else if (result.skipped) skipped.push({ url: u, reason: result.skipped });
      else files.push(result);
    }));

    await Promise.all(tasks);
    return {
      files,
      skipped,
      truncations,
      stats: { downloaded: files.length, skipped: skipped.length, truncated: truncations.length }
    };
  }

  return { downloadAll };
}

module.exports = { createAssetService };
