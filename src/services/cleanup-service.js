'use strict';

/**
 * services/cleanup-service.js — per-job cleanup + orphan sweeps.
 * Every exit path funnels through here (Section I), and every delete is
 * containment-checked so a sweep can never touch anything outside TEMP_DIR.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { assertInside } = require('../utils/filename');

function createCleanupService({ config, logger, isJobActive = () => false }) {
  const root = config.tempDir;

  async function ensureTempRoot() {
    await fsp.mkdir(root, { recursive: true });
  }

  async function createJobDir(jobId) {
    const dir = assertInside(root, path.join(root, jobId));
    const filesDir = path.join(dir, 'files');
    await fsp.mkdir(filesDir, { recursive: true });
    return { dir, filesDir };
  }

  /**
   * The boot sweep deletes EVERYTHING inside the temp root, so a temp root that
   * contains the application (or a filesystem root) would wipe the deployment.
   * Refuse those instead of trusting the operator to have read the README.
   */
  function assertSafeTempDir(dir) {
    const resolved = path.resolve(dir);
    const sep = path.sep;
    const problems = [];

    if (resolved === path.parse(resolved).root) problems.push('a filesystem root');

    const cwd = path.resolve(process.cwd());
    if (resolved === cwd || cwd.startsWith(resolved + sep)) {
      problems.push('a parent of (or equal to) the working directory');
    }

    if (process.env.WEBZIP_FRONTEND_FILE) {
      const frontendDir = path.dirname(path.resolve(process.env.WEBZIP_FRONTEND_FILE));
      if (resolved === frontendDir || frontendDir.startsWith(resolved + sep)) {
        problems.push('a parent of the frontend file');
      }
    }

    if (problems.length) {
      throw new Error(`Refusing to use TEMP_DIR="${dir}": it is ${problems.join(' and ')}. `
        + 'The startup sweep deletes everything inside TEMP_DIR, so it must be a dedicated empty directory.');
    }
    return resolved;
  }

  async function removePath(target) {
    const safe = assertInside(root, target);
    await fsp.rm(safe, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }

  async function removeJobDir(jobId) {
    try {
      await removePath(path.join(root, jobId));
      logger?.debug?.({ jobId }, 'job directory removed');
    } catch (err) {
      logger?.error?.({ jobId, err: err.message }, 'failed to remove job directory');
    }
  }

  async function listJobDirs() {
    try {
      const entries = await fsp.readdir(root, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }

  /** Boot-time sweep: a fresh process has no valid registry, so everything left is orphaned. */
  async function sweepOrphansOnBoot() {
    await ensureTempRoot();
    const dirs = await listJobDirs();
    for (const name of dirs) {
      await removePath(path.join(root, name));
    }
    if (dirs.length) logger?.info?.({ removed: dirs.length }, 'boot sweep removed orphaned job directories');
    return dirs.length;
  }

  /** Safety net for any job dir whose "cleanup after completion" path failed. */
  async function sweepStale() {
    const now = Date.now();
    let removed = 0;
    for (const name of await listJobDirs()) {
      if (isJobActive(name)) continue;
      const dir = path.join(root, name);
      try {
        const { mtimeMs } = await fsp.stat(dir);
        if (now - mtimeMs > config.jobTimeoutMs) {
          await removePath(dir);
          removed += 1;
        }
      } catch (err) {
        if (err.code !== 'ENOENT') logger?.warn?.({ dir, err: err.message }, 'sweep stat failed');
      }
    }
    if (removed) logger?.info?.({ removed }, 'periodic sweep removed stale job directories');
    return removed;
  }

  let timer = null;
  function startPeriodicSweep() {
    if (timer) return;
    timer = setInterval(() => {
      sweepStale().catch((err) => logger?.error?.({ err: err.message }, 'sweep failed'));
    }, config.cleanupSweepIntervalMs);
    timer.unref?.();
  }

  function stopPeriodicSweep() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  async function removeAll() {
    stopPeriodicSweep();
    for (const name of await listJobDirs()) {
      await removePath(path.join(root, name));
    }
  }

  return {
    root,
    assertSafeTempDir,
    ensureTempRoot,
    createJobDir,
    removeJobDir,
    sweepOrphansOnBoot,
    sweepStale,
    startPeriodicSweep,
    stopPeriodicSweep,
    removeAll,
    listJobDirs
  };
}

module.exports = { createCleanupService };
