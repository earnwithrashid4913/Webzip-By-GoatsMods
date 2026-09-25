'use strict';

const express = require('express');

/** GET /health (liveness) and GET /api/health (readiness) */
function createHealthRouter({ healthController }) {
  const router = express.Router();
  router.get('/', healthController.liveness);
  return router;
}

module.exports = { createHealthRouter };
