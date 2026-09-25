'use strict';

const express = require('express');

/** POST /api/zip */
function createZipRouter({ zipController, jsonBodyLimitMiddleware }) {
  const router = express.Router();
  router.post('/', jsonBodyLimitMiddleware, zipController);
  return router;
}

module.exports = { createZipRouter };
