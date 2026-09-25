'use strict';

/**
 * config/config.js — reads + validates every environment variable ONCE at boot.
 * Nothing downstream reads process.env directly. Fail fast, fail loud.
 *
 * Defaults are tuned for the actual production target:
 *   Pterodactyl · 300 MB RAM · 700 MB disk · 24/7 · one archive at a time.
 * Stability is preferred over attempting very large websites.
 */

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

const DEFAULTS = {
  PORT: 3000,
  HOST: '0.0.0.0',
  NODE_ENV: 'production',
  LOG_LEVEL: 'info',

  // --- crawl breadth (conservative) ---
  MAX_PAGES: 25,
  MAX_ASSETS: 150,
  MAX_DEPTH: 2,
  CROSS_ORIGIN_PAGES: false,
  RESPECT_ROBOTS: true,
  USER_AGENT: 'WebZip/1.0 (+self-hosted website archiver)',

  // --- size + time limits ---
  MAX_TOTAL_SIZE: 104857600, // 100 MB per archive
  MAX_FILE_SIZE: 10485760, // 10 MB per file
  REQUEST_TIMEOUT_MS: 12000,
  JOB_TIMEOUT_MS: 90000,
  MAX_REDIRECTS: 5,
  MAX_URL_LENGTH: 2048,

  // --- concurrency (one archive at a time on 300 MB) ---
  MAX_CONCURRENT_DOWNLOADS: 3,
  MAX_CONCURRENT_JOBS: 1,
  ADMISSION_QUEUE_TIMEOUT_MS: 1500,

  // --- abuse control ---
  RATE_LIMIT_WINDOW_MS: 60000,
  RATE_LIMIT_MAX: 6,
  ALLOWED_PORTS: '80,443',
  REQUEST_BODY_LIMIT: '16kb',
  TRUST_PROXY: '0',

  // --- resource guards (application level, below the container limits) ---
  MAX_RSS_MB: 230, // container is 300 MB
  MAX_TEMP_DISK_MB: 400, // disk is 700 MB, deps take ~26 MB

  // --- storage ---
  TEMP_DIR: '/tmp/webzip',
  CLEANUP_SWEEP_INTERVAL_MS: 120000,

  // --- output ---
  FILENAME_SUFFIX: 'OnlyF!xaDev', // -> "<hostname>-OnlyF!xaDev.zip"

  // --- TEST ONLY ---
  SSRF_ALLOW_LOOPBACK: false
};

function asBool(name, raw, def) {
  if (raw === undefined || raw === '') return def;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  throw new Error(`Config ${name} must be a boolean, got "${raw}"`);
}

function asInt(name, raw, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || Number.isNaN(n)) {
    throw new Error(`Config ${name} must be an integer, got "${raw}"`);
  }
  if (n < min || n > max) {
    throw new Error(`Config ${name} must be between ${min} and ${max}, got ${n}`);
  }
  return n;
}

function asString(name, raw, def) {
  if (raw === undefined || raw === '') return def;
  return String(raw);
}

function asPortList(raw, def) {
  if (raw === undefined || raw === '') return def;
  const ports = String(raw)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const n = Number(p);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new Error(`Config ALLOWED_PORTS contains an invalid port: "${p}"`);
      }
      return n;
    });
  if (!ports.length) return def;
  return ports;
}

/**
 * TRUST_PROXY decides who is allowed to tell us the client IP, so it is parsed
 * strictly. `true` (trust every hop of X-Forwarded-For) is REFUSED: behind a
 * single reverse proxy it lets any client spoof their IP and dodge the rate
 * limiter. Use a hop count (1) or an explicit subnet instead.
 */
function asTrustProxy(raw, def) {
  const value = raw === undefined || raw === '' ? def : String(raw).trim();

  if (value === 'true') {
    throw new Error(
      'Config TRUST_PROXY=true is refused: it trusts every X-Forwarded-For hop and lets clients spoof their IP. Use a hop count (e.g. 1) or a subnet (e.g. 10.0.0.0/8).'
    );
  }
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    if (hops > 5) throw new Error('Config TRUST_PROXY hop count must be <= 5.');
    return hops;
  }
  if (['loopback', 'uniquelocal'].includes(value)) return value;
  // A CIDR or exact subnet, e.g. "10.0.0.0/8" or "172.16.0.1"
  const cidr = value.split('/');
  if (net.isIP(cidr[0]) && (cidr.length === 1 || /^\d{1,3}$/.test(cidr[1]))) return value;

  throw new Error(
    `Config TRUST_PROXY must be 0, a hop count, "loopback", "uniquelocal" or an IP/CIDR — got "${value}"`
  );
}

/**
 * Minimal, dependency-free .env loader.
 *
 * Node does not read .env on its own and the Pterodactyl startup command must
 * stay exactly "node src/server.js", so the file is parsed here.
 * Precedence: real process environment  >  .env.<NODE_ENV>  >  .env.
 * A variable that is already set in the environment is never overwritten, so
 * panel/host variables always win over a checked-in file.
 *
 * @returns {string[]} the files that were read
 */
function loadEnvFiles({ cwd = process.cwd(), env = process.env } = {}) {
  const files = [];
  if (env.NODE_ENV) files.push(path.join(cwd, `.env.${env.NODE_ENV}`));
  files.push(path.join(cwd, '.env'));

  const loaded = [];
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (_) {
      continue; // no such file — perfectly normal
    }
    loaded.push(file);

    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;

      const key = match[1];
      const rawValue = match[2];
      const quoted = /^"([^"]*)"$|^'([^']*)'$/.exec(rawValue.trim());
      // Quoted values keep everything inside the quotes; bare values may carry
      // a trailing "  # comment".
      const value = quoted
        ? (quoted[1] !== undefined ? quoted[1] : quoted[2])
        : rawValue.replace(/\s+#.*$/, '').trim();

      if (env[key] === undefined) env[key] = value;
    }
  }
  return loaded;
}

function loadConfig(env = process.env) {
  const cfg = {
    // Pterodactyl injects the allocation port as SERVER_PORT; accept either.
    port: asInt('PORT', env.PORT || env.SERVER_PORT, DEFAULTS.PORT, { min: 1, max: 65535 }),
    host: asString('HOST', env.HOST, DEFAULTS.HOST),
    nodeEnv: asString('NODE_ENV', env.NODE_ENV, DEFAULTS.NODE_ENV),
    logLevel: asString('LOG_LEVEL', env.LOG_LEVEL, DEFAULTS.LOG_LEVEL),

    maxPages: asInt('MAX_PAGES', env.MAX_PAGES, DEFAULTS.MAX_PAGES, { min: 1, max: 100000 }),
    maxAssets: asInt('MAX_ASSETS', env.MAX_ASSETS, DEFAULTS.MAX_ASSETS, { min: 1, max: 1000000 }),
    maxDepth: asInt('MAX_DEPTH', env.MAX_DEPTH, DEFAULTS.MAX_DEPTH, { min: 0, max: 20 }),
    crossOriginPages: asBool('CROSS_ORIGIN_PAGES', env.CROSS_ORIGIN_PAGES, DEFAULTS.CROSS_ORIGIN_PAGES),
    respectRobots: asBool('RESPECT_ROBOTS', env.RESPECT_ROBOTS, DEFAULTS.RESPECT_ROBOTS),
    userAgent: asString('USER_AGENT', env.USER_AGENT, DEFAULTS.USER_AGENT),

    maxTotalSize: asInt('MAX_TOTAL_SIZE', env.MAX_TOTAL_SIZE, DEFAULTS.MAX_TOTAL_SIZE, { min: 1024 }),
    maxFileSize: asInt('MAX_FILE_SIZE', env.MAX_FILE_SIZE, DEFAULTS.MAX_FILE_SIZE, { min: 1024 }),
    requestTimeoutMs: asInt('REQUEST_TIMEOUT_MS', env.REQUEST_TIMEOUT_MS, DEFAULTS.REQUEST_TIMEOUT_MS, { min: 100 }),
    jobTimeoutMs: asInt('JOB_TIMEOUT_MS', env.JOB_TIMEOUT_MS, DEFAULTS.JOB_TIMEOUT_MS, { min: 1000 }),
    maxRedirects: asInt('MAX_REDIRECTS', env.MAX_REDIRECTS, DEFAULTS.MAX_REDIRECTS, { min: 0, max: 20 }),
    maxUrlLength: asInt('MAX_URL_LENGTH', env.MAX_URL_LENGTH, DEFAULTS.MAX_URL_LENGTH, { min: 32, max: 8192 }),

    maxConcurrentDownloads: asInt('MAX_CONCURRENT_DOWNLOADS', env.MAX_CONCURRENT_DOWNLOADS, DEFAULTS.MAX_CONCURRENT_DOWNLOADS, { min: 1, max: 200 }),
    maxConcurrentJobs: asInt('MAX_CONCURRENT_JOBS', env.MAX_CONCURRENT_JOBS, DEFAULTS.MAX_CONCURRENT_JOBS, { min: 1, max: 1000 }),
    admissionQueueTimeoutMs: asInt('ADMISSION_QUEUE_TIMEOUT_MS', env.ADMISSION_QUEUE_TIMEOUT_MS, DEFAULTS.ADMISSION_QUEUE_TIMEOUT_MS, { min: 0, max: 120000 }),

    rateLimitWindowMs: asInt('RATE_LIMIT_WINDOW_MS', env.RATE_LIMIT_WINDOW_MS, DEFAULTS.RATE_LIMIT_WINDOW_MS, { min: 100 }),
    rateLimitMax: asInt('RATE_LIMIT_MAX', env.RATE_LIMIT_MAX, DEFAULTS.RATE_LIMIT_MAX, { min: 1, max: 1000000 }),
    allowedPorts: asPortList(env.ALLOWED_PORTS, DEFAULTS.ALLOWED_PORTS.split(',').map(Number)),
    requestBodyLimit: asString('REQUEST_BODY_LIMIT', env.REQUEST_BODY_LIMIT, DEFAULTS.REQUEST_BODY_LIMIT),
    trustProxy: asTrustProxy(env.TRUST_PROXY, DEFAULTS.TRUST_PROXY),

    maxRssMb: asInt('MAX_RSS_MB', env.MAX_RSS_MB, DEFAULTS.MAX_RSS_MB, { min: 0, max: 1048576 }),
    maxTempDiskMb: asInt('MAX_TEMP_DISK_MB', env.MAX_TEMP_DISK_MB, DEFAULTS.MAX_TEMP_DISK_MB, { min: 1, max: 1048576 }),

    tempDir: path.resolve(asString('TEMP_DIR', env.TEMP_DIR, DEFAULTS.TEMP_DIR)),
    cleanupSweepIntervalMs: asInt('CLEANUP_SWEEP_INTERVAL_MS', env.CLEANUP_SWEEP_INTERVAL_MS, DEFAULTS.CLEANUP_SWEEP_INTERVAL_MS, { min: 1000 }),

    filenameSuffix: asString('FILENAME_SUFFIX', env.FILENAME_SUFFIX, DEFAULTS.FILENAME_SUFFIX)
      .replace(/[^A-Za-z0-9!._-]/g, '')
      .slice(0, 40) || DEFAULTS.FILENAME_SUFFIX,

    ssrfAllowLoopback: asBool('SSRF_ALLOW_LOOPBACK', env.SSRF_ALLOW_LOOPBACK, DEFAULTS.SSRF_ALLOW_LOOPBACK)
  };

  // ---- cross-field + safety assertions ---------------------------------
  if (cfg.ssrfAllowLoopback && cfg.nodeEnv === 'production') {
    throw new Error('Config SSRF_ALLOW_LOOPBACK=true is refused when NODE_ENV=production (test-only escape hatch).');
  }
  if (cfg.maxFileSize > cfg.maxTotalSize) {
    throw new Error('Config MAX_FILE_SIZE cannot be larger than MAX_TOTAL_SIZE.');
  }
  // A single job can occupy up to MAX_TOTAL_SIZE of downloads plus roughly the
  // same again for the assembled archive; refuse a combination that could not
  // fit inside the temp-disk ceiling.
  const worstCaseMb = (cfg.maxTotalSize * 2) / 1048576;
  if (worstCaseMb * cfg.maxConcurrentJobs > cfg.maxTempDiskMb) {
    throw new Error(
      `Config MAX_TOTAL_SIZE x MAX_CONCURRENT_JOBS (${Math.round(worstCaseMb * cfg.maxConcurrentJobs)} MB worst case) exceeds MAX_TEMP_DISK_MB (${cfg.maxTempDiskMb} MB).`
    );
  }

  return Object.freeze(cfg);
}

module.exports = { loadConfig, loadEnvFiles, DEFAULTS };
