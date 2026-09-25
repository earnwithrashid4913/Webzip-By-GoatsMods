'use strict';

const crypto = require('node:crypto');

/**
 * middleware/request-id.js — correlation id for logs AND for the JSON error
 * body the frontend surfaces. 8 hex chars, e.g. "a1b2c3d4".
 */
function requestId() {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    const id = /^[a-f0-9]{1,64}$/i.test(incoming || '') ? incoming.toLowerCase() : crypto.randomBytes(4).toString('hex');
    req.requestId = id;
    res.setHeader('X-Request-Id', id);
    next();
  };
}

module.exports = { requestId };
