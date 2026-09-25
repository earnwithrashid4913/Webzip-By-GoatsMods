'use strict';

/**
 * utils/filename.js — every filename that reaches the client or the disk is
 * generated here, server-side. Nothing is ever taken verbatim from crawled
 * content (Section D: malicious filenames / headers).
 */

const path = require('path');
const crypto = require('node:crypto');

const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const MAX_SEGMENT = 200;
const MAX_ENTRY_LENGTH = 1000;

/** example.com -> example-com ; a.b.co.uk -> a-b-co-uk */
function sanitizeHostname(host) {
  const clean = String(host || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return (clean || 'site').slice(0, 120);
}

/** "https://example.com/x" + "OnlyF!xaDev" -> "example-com-OnlyF!xaDev.zip" */
function buildArchiveName(sourceUrl, suffix) {
  let host = 'site';
  try {
    host = sanitizeHostname(new URL(sourceUrl).hostname);
  } catch (_) {
    host = 'site';
  }
  const safeSuffix = String(suffix || '').replace(/[^A-Za-z0-9!._-]/g, '').slice(0, 40);
  const base = safeSuffix ? `${host}-${safeSuffix}` : host;
  // RFC 6266 / Content-Disposition: keep it ASCII and free of " \ ; CR LF
  return base.replace(/["\\;\r\n]/g, '') + '.zip';
}

function sanitizeSegment(seg) {
  let s = String(seg)
    .replace(/[\u0000-\u001f\u007f]/g, '') // control chars
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') // windows-illegal + separators
    .replace(/[.\s]+$/g, '') // trailing dots/spaces (windows)
    .replace(/_{2,}/g, '_')
    .trim();
  if (RESERVED_DEVICE_NAMES.test(s)) s = `_${s}`;
  if (!s || s === '.' || s === '..') s = '_';
  return s.slice(0, MAX_SEGMENT);
}

/**
 * Turn any attacker-controlled string into a safe RELATIVE path.
 * Strips "..", leading "/", null bytes, device names; never absolute.
 */
function sanitizeEntryName(raw, fallback = 'index.html') {
  const str = String(raw == null ? '' : raw).replace(/\0/g, '');
  const parts = str
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter((p) => p.length > 0 && p !== '.' && p !== '..')
    .map(sanitizeSegment);

  let joined = parts.join('/');
  if (joined.length > MAX_ENTRY_LENGTH) {
    const ext = path.posix.extname(joined);
    joined = joined.slice(0, MAX_ENTRY_LENGTH - ext.length - 9) + '-' + crypto.randomBytes(4).toString('hex') + ext;
  }
  return joined || fallback;
}

/**
 * Map a crawled URL to an archive entry path.
 *   https://a.com/            -> index.html
 *   https://a.com/about/      -> about/index.html
 *   https://a.com/x/y.css     -> x/y.css
 *   https://a.com/blog        -> blog/index.html   (extensionless = route)
 * Query strings are dropped; collisions are resolved by the caller's dedupe.
 */
function urlToEntryName(urlLike) {
  let u;
  try {
    u = typeof urlLike === 'string' ? new URL(urlLike) : urlLike;
  } catch (_) {
    return 'index.html';
  }

  let rawPath = u.pathname || '/';
  try {
    rawPath = decodeURIComponent(rawPath);
  } catch (_) {
    /* keep the raw form if it is not valid percent-encoding */
  }

  const segments = rawPath.split('/').filter(Boolean);
  if (segments.length === 0) return 'index.html';

  const last = segments[segments.length - 1];
  const looksLikeFile = /\.[A-Za-z0-9]{1,10}$/.test(last);
  if (!looksLikeFile) segments.push('index.html');

  return sanitizeEntryName(segments.join('/'), 'index.html');
}

/** Unique entry names inside one archive: about.html, about-2.html, ... */
function uniqueEntryName(entryName, used) {
  if (!used.has(entryName)) {
    used.add(entryName);
    return entryName;
  }
  const ext = path.posix.extname(entryName);
  const stem = entryName.slice(0, entryName.length - ext.length);
  for (let i = 2; i < 100000; i++) {
    const candidate = `${stem}-${i}${ext}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  return `${stem}-${crypto.randomBytes(4).toString('hex')}${ext}`;
}

/**
 * Containment test. Every write is checked against the job directory before it
 * happens, so no archive entry and no crawled path can escape it (Section D).
 */
function assertInside(rootDir, targetPath) {
  const root = path.resolve(rootDir) + path.sep;
  const target = path.resolve(targetPath);
  if (target !== path.resolve(rootDir) && !target.startsWith(root)) {
    const err = new Error(`Refusing path outside the job directory: ${target}`);
    err.code = 'PATH_ESCAPE';
    throw err;
  }
  return target;
}

module.exports = {
  sanitizeHostname,
  buildArchiveName,
  sanitizeSegment,
  sanitizeEntryName,
  urlToEntryName,
  uniqueEntryName,
  assertInside
};
