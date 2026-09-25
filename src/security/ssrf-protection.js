'use strict';

/**
 * security/ssrf-protection.js — the gate every outbound connection passes
 * through: the submitted URL, every crawled link, every asset, every redirect.
 *
 * Steps 3–6 of Section D live here:
 *   3. DNS resolution + blocked-range rejection
 *   4. DNS pinning (connect to the validated IP, TLS still checked by hostname)
 *   5. redirects are NOT auto-followed; each Location is re-validated from step 1
 *   6. streaming size caps, including a cap on DECOMPRESSED bytes
 */

const net = require('node:net');
const zlib = require('node:zlib');
const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const dns = require('node:dns').promises;
const { Agent, request: undiciRequest } = require('undici');

const { ValidationError, UpstreamError, SizeLimitError } = require('../utils/errors');

/** [cidr, kind] — kind "loopback" can be relaxed by the TEST-ONLY flag. */
const V4_RANGES = [
  ['127.0.0.0/8', 'loopback'],
  ['10.0.0.0/8', 'private'],
  ['172.16.0.0/12', 'private'],
  ['192.168.0.0/16', 'private'],
  ['169.254.0.0/16', 'link-local'], // includes cloud metadata 169.254.169.254
  ['0.0.0.0/8', 'reserved'],
  ['100.64.0.0/10', 'cgnat'],
  ['192.0.0.0/24', 'reserved'],
  ['192.0.2.0/24', 'documentation'],
  ['198.18.0.0/15', 'benchmark'],
  ['198.51.100.0/24', 'documentation'],
  ['203.0.113.0/24', 'documentation'],
  ['255.255.255.255/32', 'broadcast'],
  ['240.0.0.0/4', 'reserved']
];

const V6_RANGES = [
  ['::1/128', 'loopback'],
  ['fc00::/7', 'unique-local'], // fd00::/8 too
  ['fe80::/10', 'link-local'],
  ['ff00::/8', 'multicast'],
  ['::/128', 'unspecified'],
  ['2001:db8::/32', 'documentation'],
  ['64:ff9b::/96', 'nat64'],
  ['100::/64', 'discard']
];

const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.tencentyun.com',
  'metadata.azure.internal',
  'instance-data',
  'metadata'
]);

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc * 256) + Number(octet), 0) >>> 0;
}

function ipv6ToBigInt(ip) {
  let addr = ip;
  if (addr.includes('%')) addr = addr.split('%')[0];
  const [head, tail] = addr.split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const missing = 8 - headParts.length - tailParts.length;
  const parts = [...headParts, ...Array(tail !== undefined ? missing : 0).fill('0'), ...tailParts];
  let value = 0n;
  for (const p of parts) {
    let group = p;
    if (group.includes('.')) {
      const v4 = ipv4ToInt(group);
      group = ((v4 >>> 16) & 0xffff).toString(16) + ':' + (v4 & 0xffff).toString(16);
      const [a, b] = group.split(':');
      value = (value << 16n) | BigInt(parseInt(a, 16));
      value = (value << 16n) | BigInt(parseInt(b, 16));
      continue;
    }
    value = (value << 16n) | BigInt(parseInt(group || '0', 16));
  }
  return value;
}

function inCidrV4(ip, cidr) {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number(bitsRaw);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

function inCidrV6(ip, cidr) {
  const [base, bitsRaw] = cidr.split('/');
  const bits = BigInt(Number(bitsRaw));
  const shift = 128n - bits;
  return (ipv6ToBigInt(ip) >> shift) === (ipv6ToBigInt(base) >> shift);
}

/** Unwraps IPv4-mapped / NAT64 / 6to4 forms so the embedded v4 is judged too. */
function embeddedV4(ip) {
  const lower = ip.toLowerCase();
  if (lower.startsWith('::ffff:')) return lower.slice(7);
  if (lower.startsWith('64:ff9b:')) {
    const tail = lower.slice(8);
    if (tail.includes('.')) return tail;
    const parts = tail.split(':').filter(Boolean);
    if (parts.length >= 2) {
      const hi = parseInt(parts[parts.length - 2], 16);
      const lo = parseInt(parts[parts.length - 1], 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
      }
    }
  }
  if (lower.startsWith('2002:')) {
    const parts = lower.slice(5).split(':').filter(Boolean);
    if (parts.length >= 2) {
      const hi = parseInt(parts[0], 16);
      const lo = parseInt(parts[1], 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        return `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
      }
    }
  }
  return null;
}

/** Returns the reason an address is blocked, or null when it is public. */
function classifyIp(ip, { allowLoopback = false } = {}) {
  if (typeof ip !== 'string' || !ip) return 'invalid';
  const clean = ip.includes('%') ? ip.split('%')[0] : ip;
  const version = net.isIP(clean);

  if (version === 4) {
    for (const [cidr, kind] of V4_RANGES) {
      if (inCidrV4(clean, cidr)) return allowLoopback && kind === 'loopback' ? null : kind;
    }
    return null;
  }

  if (version === 6) {
    const v4 = embeddedV4(clean);
    if (v4 && net.isIPv4(v4)) return classifyIp(v4, { allowLoopback });
    for (const [cidr, kind] of V6_RANGES) {
      if (inCidrV6(clean, cidr)) return allowLoopback && kind === 'loopback' ? null : kind;
    }
    return null;
  }

  return 'invalid';
}

function isBlockedIp(ip, options) {
  return classifyIp(ip, options) !== null;
}

function isBlockedHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return true;
  if (BLOCKED_HOSTNAMES.has(h)) return true;
  if (h === 'fd00:ec2::254') return true;
  return ['.localhost', '.local', '.internal', '.localdomain', '.invalid', '.lan'].some((s) => h.endsWith(s));
}

/** Step 3 + 4: resolve, reject if ANY address is blocked, return the pin. */
async function resolveAndPin(hostname, { allowLoopback = false } = {}) {
  if (isBlockedHostname(hostname)) {
    throw new ValidationError(`Hostname "${hostname}" is not allowed.`);
  }
  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch (err) {
    throw new UpstreamError(`DNS lookup failed for ${hostname}`, { cause: err });
  }
  if (!addresses.length) throw new UpstreamError(`No DNS records for ${hostname}`);

  for (const a of addresses) {
    const kind = classifyIp(a.address, { allowLoopback });
    if (kind) {
      throw new ValidationError(`Hostname resolves to a blocked (${kind}) address.`);
    }
  }
  return { ip: addresses[0].address, family: addresses[0].family };
}

/** Enforces a byte cap on a stream (counts DECOMPRESSED bytes). */
function byteCounter(maxBytes, onBytes) {
  let seen = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > maxBytes) {
        cb(new SizeLimitError(`Exceeded the ${maxBytes} byte cap.`));
        return;
      }
      onBytes?.(seen);
      cb(null, chunk);
    }
  });
}

function decodeStream(bodyStream, contentEncoding) {
  const encodings = String(contentEncoding || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .reverse(); // last applied is first to undo

  let stream = bodyStream;
  for (const enc of encodings) {
    if (enc === 'gzip' || enc === 'x-gzip') stream = stream.pipe(zlib.createGunzip());
    else if (enc === 'deflate') stream = stream.pipe(zlib.createInflate());
    else if (enc === 'br') stream = stream.pipe(zlib.createBrotliDecompress());
    // identity / unknown: leave as-is
  }
  return stream;
}

/**
 * Builds the SSRF-safe fetcher for one process.
 * `validate` is injected (url-validator) so this module has no import cycle.
 */
/**
 * Custom `dns.lookup` used for DNS pinning.
 *
 * Node calls this as `lookup(host, { hints, all: true }, cb)` and then expects
 * an ARRAY of { address, family } — returning the scalar (address, family) form
 * makes net.connect fail with "Invalid IP address: undefined". Both shapes are
 * handled, as is the 2-argument call.
 */
function createPinnedLookup(pins) {
  return function lookup(hostname, options, callback) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    const wantsAll = Boolean(options && options.all);
    const pin = pins.get(hostname);

    if (!pin) {
      // Fail closed: no validated pin, no connection.
      const err = new Error(`No DNS pin for ${hostname}`);
      if (wantsAll) callback(err, []);
      else callback(err, null, 0);
      return;
    }

    if (wantsAll) callback(null, [{ address: pin.ip, family: pin.family }]);
    else callback(null, pin.ip, pin.family);
  };
}

const MAX_PINNED_HOSTS = 1000;

/**
 * @param {object} opts
 * @param {function} [opts.resolve] DNS resolver to use (defaults to
 *   resolveAndPin). Injectable so tests can simulate a rebinding attacker
 *   without needing a hostile DNS server.
 */
function createSafeFetch({ config, logger, resolve = resolveAndPin }) {
  const pins = new Map(); // hostname -> { ip, family }
  const lookup = createPinnedLookup(pins);

  function setPin(hostname, pin) {
    // Bounded cache: an unbounded Map would grow forever on a 24/7 process.
    // Clearing is safe because a missing pin fails closed, and the next
    // request simply re-validates the host.
    if (pins.size >= MAX_PINNED_HOSTS) pins.clear();
    pins.set(hostname, pin);
  }

  const agent = new Agent({
    connect: {
      lookup,
      timeout: config.requestTimeoutMs
      // TLS is still validated against the ORIGINAL hostname (SNI) because the
      // request origin keeps the hostname; only the socket target is pinned.
    },
    headersTimeout: config.requestTimeoutMs,
    bodyTimeout: config.requestTimeoutMs,
    keepAliveTimeout: 5000,
    connections: 32
  });

  async function fetchSafe(rawUrl, { validate, signal, redirects = config.maxRedirects, accept = '*/*' } = {}) {
    let current = rawUrl;
    let hops = 0;

    for (;;) {
      const { url } = validate(current); // step 1 + 2 (+ scheme/port/credentials)
      const hostname = url.hostname.replace(/^\[|\]$/g, '');

      const pin = await resolve(hostname, { allowLoopback: config.ssrfAllowLoopback });
      // Defence in depth: never trust a resolver's answer on its own. Even if a
      // hostile/buggy resolver "approves" a private address, the pin is refused.
      if (!pin || isBlockedIp(pin.ip, { allowLoopback: config.ssrfAllowLoopback })) {
        throw new ValidationError(`Hostname resolves to a blocked address.`);
      }
      setPin(hostname, pin);

      let res;
      try {
        res = await undiciRequest(url, {
          dispatcher: agent,
          method: 'GET',
          signal,
          maxRedirections: 0, // step 5: we handle redirects ourselves
          headers: {
            'user-agent': config.userAgent,
            accept,
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'en-US,en;q=0.9'
          },
          headersTimeout: config.requestTimeoutMs,
          bodyTimeout: config.requestTimeoutMs
        });
      } catch (err) {
        if (err.name === 'AbortError' || err.code === 'UND_ERR_ABORTED') throw err;
        throw new UpstreamError(`Request to ${url.origin} failed: ${err.message}`);
      }

      const status = res.statusCode;

      if (status >= 300 && status < 400) {
        const location = res.headers.location;
        await res.body.dump().catch(() => {});
        if (!location) throw new UpstreamError(`Redirect ${status} without a Location header.`, { statusCode: status });
        if (hops >= redirects) throw new UpstreamError(`Too many redirects (max ${redirects}).`, { statusCode: status });
        hops += 1;
        let next;
        try {
          next = new URL(String(location).split('#')[0], url).toString();
        } catch (_) {
          throw new ValidationError(`Redirect target is not a valid URL.`);
        }
        logger?.debug?.({ hops, next }, 'following redirect after re-validation');
        current = next; // re-enters validate() + resolveAndPin() at the top
        continue;
      }

      if (status < 200 || status >= 300) {
        await res.body.dump().catch(() => {});
        throw new UpstreamError(`Target responded with HTTP ${status}.`, { statusCode: status });
      }

      const decoded = decodeStream(res.body, res.headers['content-encoding']);
      return {
        url,
        status,
        headers: res.headers,
        stream: decoded,
        contentType: String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase(),
        destroy: () => { res.body?.destroy?.(); }
      };
    }
  }

  /** Read a whole (decoded) body into memory, aborting the instant a cap trips. */
  async function readBodyLimited(fetchResult, maxBytes, { signal, onBytes } = {}) {
    const chunks = [];
    let total = 0;
    try {
      // Counts DECOMPRESSED bytes, so a zip/gzip bomb cannot slip through.
      for await (const chunk of fetchResult.stream) {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        total += chunk.length;
        if (total > maxBytes) throw new SizeLimitError(`Exceeded the ${maxBytes} byte cap.`);
        onBytes?.(total);
        chunks.push(chunk);
      }
    } catch (err) {
      fetchResult.destroy();
      throw err;
    }
    return Buffer.concat(chunks, total);
  }

  /** Stream a (decoded) body to disk, aborting the instant a cap trips. */
  async function pipeBodyToFile(fetchResult, filePath, maxBytes, { signal, onBytes } = {}) {
    const out = fs.createWriteStream(filePath);
    const counter = byteCounter(maxBytes, onBytes);
    try {
      await pipeline(fetchResult.stream, counter, out);
    } catch (err) {
      fetchResult.destroy();
      out.destroy();
      await fs.promises.unlink(filePath).catch(() => {});
      throw err;
    }
    const { size } = await fs.promises.stat(filePath);
    return { size };
  }

  return {
    fetchSafe,
    readBodyLimited,
    pipeBodyToFile,
    // close() waits politely; destroy() guarantees the keep-alive sockets are
    // released so the process can actually exit during shutdown.
    close: async () => { await agent.close().catch(() => {}); await agent.destroy().catch(() => {}); }
  };
}

module.exports = {
  createPinnedLookup,
  classifyIp,
  isBlockedIp,
  isBlockedHostname,
  resolveAndPin,
  createSafeFetch,
};
