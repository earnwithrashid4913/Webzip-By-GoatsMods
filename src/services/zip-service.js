'use strict';

/**
 * services/zip-service.js — streaming archive assembly with archiver.
 * Every entry name is re-sanitized here and containment-checked against the
 * job directory before it is added, so neither a crawled path nor a crafted
 * entry name can escape (Section D).
 */

const fs = require('node:fs');
const path = require('node:path');
const archiver = require('archiver');

const { sanitizeEntryName, uniqueEntryName, assertInside } = require('../utils/filename');

function createZipService({ config, logger }) {
  /**
   * @param {{ jobDir: string, files: Array<{diskPath:string, entryName?:string}>, comment?: string }}
   * @returns {Promise<{ zipPath: string, size: number, entries: number }>}
   */
  async function createArchive({ jobDir, files, comment, signal }) {
    const zipPath = assertInside(jobDir, path.join(jobDir, 'archive.zip'));
    const output = fs.createWriteStream(zipPath);
    // NOTE: the archive comment is a constructor option in archiver/zip-stream,
    // not a method — archiver 7 has no .comment().
    const archive = archiver('zip', {
      zlib: { level: 6 },
      comment: comment ? String(comment).slice(0, 500) : undefined
    });

    // Never reject here: every failure is captured so nothing can escape as an
    // unhandled rejection (which would take the whole process down).
    let failure = null;
    const finished = new Promise((resolve) => {
      output.on('close', resolve);
      output.on('error', (err) => { failure = failure || err; resolve(); });
      archive.on('error', (err) => { failure = failure || err; resolve(); });
      archive.on('warning', (err) => {
        if (err.code === 'ENOENT') logger?.warn?.({ err: err.message }, 'zip warning: missing file');
        else { failure = failure || err; resolve(); }
      });
    });

    archive.pipe(output);

    const used = new Set();
    let entries = 0;
    let bytes = 0;

    for (const file of files) {
      // A job timeout during packaging must stop work, not finish the archive.
      if (signal?.aborted) {
        archive.abort();
        output.destroy();
        await finished;
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      }

      // Containment test before anything is read.
      assertInside(jobDir, file.diskPath);

      const safeName = uniqueEntryName(sanitizeEntryName(file.entryName || path.basename(file.diskPath)), used);

      let size = 0;
      try {
        ({ size } = fs.statSync(file.diskPath));
      } catch (err) {
        logger?.warn?.({ file: file.diskPath, err: err.message }, 'zip: skipping unreadable file');
        continue;
      }

      bytes += size;
      if (bytes > config.maxTotalSize) {
        logger?.warn?.({ bytes, max: config.maxTotalSize }, 'zip: stopping at MAX_TOTAL_SIZE');
        break;
      }

      archive.file(file.diskPath, { name: safeName, date: new Date() });
      entries += 1;
    }

    await archive.finalize().catch((err) => {
      failure = failure || err;
      archive.abort();
    });
    await finished;

    if (failure) {
      output.destroy();
      throw failure;
    }

    const { size } = await fs.promises.stat(zipPath);
    return { zipPath, size, entries };
  }

  return { createArchive };
}

module.exports = { createZipService };
