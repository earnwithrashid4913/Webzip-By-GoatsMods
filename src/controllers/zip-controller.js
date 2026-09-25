'use strict';

/**
 * controllers/zip-controller.js — validates, runs the job, streams the ZIP.
 * Emits exactly the four documented response headers.
 */

const fs = require('node:fs');

const { validateUrl } = require('../security/url-validator');
const { buildArchiveName } = require('../utils/filename');
const { InternalError } = require('../utils/errors');

/** Header values must stay ASCII / free of CR-LF. */
function asciiHeaderValue(value) {
  return String(value).replace(/[^\x20-\x7e]/g, '').replace(/[\r\n]/g, '').slice(0, 500);
}

function createZipController({ config, logger, jobService }) {
  return async function zipHandler(req, res, next) {
    // Fail fast on a bad URL before consuming a job slot or a temp directory.
    let validated;
    try {
      validated = validateUrl(req.body && req.body.url, config);
    } catch (err) {
      return next(err);
    }

    const sourceUrl = validated.urlString;

    let handle = null;
    let stream = null;
    let cleaned = false;
    let clientGone = false;

    const finishOnce = async (why) => {
      if (cleaned) return;
      cleaned = true;
      if (stream) stream.destroy();
      if (handle) await handle.cleanup(); // awaited: removal finishes, not just starts
      logger?.debug?.({ requestId: req.requestId, why }, 'request finished');
    };

    // Registered BEFORE the job starts: a client that hangs up mid-crawl must
    // abort the work and release the job slot, not leave it in the registry.
    const clientAbort = new AbortController();
    res.once('close', () => {
      clientGone = true;
      clientAbort.abort();
      finishOnce('client-close').catch((err) => {
        logger?.warn?.({ requestId: req.requestId, err: err.message }, 'cleanup after client close failed');
      });
    });

    try {
      handle = await jobService.runJob({
        url: sourceUrl,
        requestId: req.requestId,
        ip: req.ip,
        signal: clientAbort.signal
      });
    } catch (err) {
      await finishOnce('job-failed');
      return next(err);
    }

    if (clientGone || res.destroyed || res.writableEnded) {
      await finishOnce('client-gone-before-response');
      return;
    }

    const fileName = buildArchiveName(sourceUrl, config.filenameSuffix);

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('X-File-Name', asciiHeaderValue(fileName));
    res.setHeader('X-Source-URL', asciiHeaderValue(sourceUrl));
    res.setHeader('Content-Length', String(handle.size));

    stream = fs.createReadStream(handle.zipPath);
    stream.on('error', (err) => {
      logger?.error?.({ jobId: handle.job.id, err: err.message }, 'failed to stream archive');
      finishOnce('stream-error').catch(() => {});
      if (!res.headersSent) next(new InternalError('Failed to stream the archive.'));
      else res.destroy();
    });
    stream.on('close', () => { finishOnce('stream-close').catch(() => {}); });

    stream.pipe(res);
  };
}

module.exports = { createZipController, asciiHeaderValue };
