'use strict';

/**
 * security/url-validator.js — steps 1 and 2 of Section D.
 *   1. scheme must be exactly http: or https:
 *   2. no embedded credentials, no control chars/whitespace, port allowlist
 * IP literals are range-checked here; hostnames are resolved in ssrf-protection.
 */

const net = require('node:net');
const { ValidationError } = require('../utils/errors');
const { isBlockedIp, isBlockedHostname } = require('./ssrf-protection');

const MAX_URL_LENGTH = 2048;
// Only C0 control chars + DEL are refused here. Spaces/tabs are left to the
// WHATWG parser: it rejects them in the host and percent-encodes them in the
// path, which gives a far more accurate error message than a blanket reject.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function parseUrl(raw, maxLength = MAX_URL_LENGTH) {
  if (typeof raw !== 'string') {
    throw new ValidationError("The 'url' field is required and must be a valid http(s) URL.");
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ValidationError("The 'url' field is required and must be a valid http(s) URL.");
  }
  if (trimmed.length > maxLength) {
    throw new ValidationError(`URL is too long (max ${maxLength} characters).`);
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw new ValidationError('URL contains control characters.');
  }
  try {
    return new URL(trimmed);
  } catch (_) {
    throw new ValidationError("The 'url' field is required and must be a valid http(s) URL.");
  }
}

/**
 * @returns {{ url: URL, urlString: string, hostname: string, port: number }}
 * @throws {ValidationError}
 */
function validateUrl(raw, config) {
  // Honour the configured cap; fall back to the built-in default when a caller
  // passes a partial config (e.g. unit tests).
  const url = parseUrl(raw, config && config.maxUrlLength ? config.maxUrlLength : MAX_URL_LENGTH);

  // Step 1 — scheme
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ValidationError(`Unsupported protocol "${url.protocol.replace(':', '')}". Only http and https are allowed.`);
  }

  // Step 2a — credentials
  if (url.username || url.password) {
    throw new ValidationError('URLs with embedded credentials are not allowed.');
  }

  // Step 2b — hostname
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname) {
    throw new ValidationError('URL has no hostname.');
  }
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
    throw new ValidationError('Localhost is not allowed.');
  }
  // Reject metadata / .internal / .local names here too, before any DNS
  // round trip. ssrf-protection re-checks them after resolution (defence twice).
  if (isBlockedHostname(hostname)) {
    throw new ValidationError(`Hostname "${hostname}" is not allowed.`);
  }

  // Step 2c — port allowlist (implicit defaults included)
  const explicitPort = url.port ? Number(url.port) : null;
  const effectivePort = explicitPort ?? (url.protocol === 'https:' ? 443 : 80);
  if (!config.allowedPorts.includes(effectivePort)) {
    throw new ValidationError(`Port ${effectivePort} is not in the allowlist (${config.allowedPorts.join(', ')}).`);
  }

  // IP literals: judge the address immediately, no DNS needed.
  if (net.isIP(hostname) && isBlockedIp(hostname, { allowLoopback: config.ssrfAllowLoopback })) {
    throw new ValidationError('That address is in a blocked network range.');
  }

  url.hash = '';
  const urlString = url.toString();

  return { url, urlString, hostname, port: effectivePort };
}

module.exports = { validateUrl, DEFAULT_MAX_URL_LENGTH: MAX_URL_LENGTH };
