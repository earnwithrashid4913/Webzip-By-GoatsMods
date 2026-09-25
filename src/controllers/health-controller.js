'use strict';

/**
 * controllers/health-controller.js — liveness and readiness.
 * Aggregate numbers only: never source URLs, job ids or client IPs.
 */

function createHealthController({ jobService }) {
  const startedAt = Date.now();

  function uptimeSeconds() {
    return Math.floor((Date.now() - startedAt) / 1000);
  }

  function liveness(_req, res) {
    res.status(200).json({ status: 'ok', uptime: uptimeSeconds() });
  }

  async function readiness(_req, res, next) {
    try {
      const stats = await jobService.stats();
      res.status(200).json({
        status: 'ok',
        activeJobs: stats.activeJobs,
        maxConcurrentJobs: stats.maxConcurrentJobs,
        storageUsedMb: stats.storageUsedMb,
        uptime: uptimeSeconds()
      });
    } catch (err) {
      next(err);
    }
  }

  return { liveness, readiness };
}

module.exports = { createHealthController };
