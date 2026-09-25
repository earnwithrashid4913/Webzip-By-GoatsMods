'use strict';

const express = require('express');

const { createZipRouter } = require('./zip');

/** Mounts every API route under one router (server mounts it at /api). */
function createApiRouter(deps) {
  const router = express.Router();
  router.use('/zip', createZipRouter(deps));
  // Documented contract: GET /api/health is the READINESS payload (aggregates),
  // while GET /health (mounted by server.js) stays the cheap liveness probe.
  router.get('/health', deps.healthController.readiness);
  return router;
}

module.exports = { createApiRouter };
