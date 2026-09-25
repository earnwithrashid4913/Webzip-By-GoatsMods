'use strict';

/**
 * services/crawler-service.js — page discovery, link/asset extraction, depth
 * control, robots.txt courtesy.
 *
 * Link extraction is regex-based (no HTML parser dependency). That is a
 * deliberate trade-off: it misses links built by client-side JS and can be
 * fooled by unusual markup. It is bounded by MAX_PAGES/MAX_DEPTH/MAX_ASSETS,
 * and every URL it yields is re-validated by the SSRF layer.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const { urlToEntryName, uniqueEntryName, assertInside } = require('../utils/filename');
const { validateUrl } = require('../security/url-validator');

const ATTR_RE = (tag, attr) =>
  new RegExp(`<${tag}\\b[^>]*?\\b${attr}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'gi');

const EXTRACTORS = [
  ATTR_RE('a', 'href'),
  ATTR_RE('link', 'href'),
  ATTR_RE('script', 'src'),
  ATTR_RE('img', 'src'),
  ATTR_RE('source', 'src'),
  ATTR_RE('embed', 'src'),
  ATTR_RE('video', 'src'),
  ATTR_RE('audio', 'src'),
  ATTR_RE('iframe', 'src')
];

const SKIP_SCHEMES = /^(javascript:|mailto:|tel:|data:|blob:|about:|file:)/i;

function absolutize(raw, baseUrl) {
  if (!raw) return null;
  const value = raw.trim();
  if (!value || SKIP_SCHEMES.test(value)) return null;
  try {
    const u = new URL(value, baseUrl);
    u.hash = '';
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch (_) {
    return null;
  }
}

/** @returns {{ pageLinks: string[], assetLinks: string[] }} */
function extractLinks(html, baseUrl) {
  const pageLinks = new Set();
  const assetLinks = new Set();

  const add = (set, value) => { if (value) set.add(value); };

  for (const re of EXTRACTORS) {
    re.lastIndex = 0;
    const isAnchor = re.source.startsWith('<a\\b');
    let m;
    while ((m = re.exec(html)) !== null) {
      const raw = m[1] ?? m[2] ?? m[3];
      const abs = absolutize(raw, baseUrl);
      if (!abs) continue;
      add(isAnchor ? pageLinks : assetLinks, abs);
    }
  }

  // srcset="<url> 1x, <url> 2x"
  const srcsetRe = /\bsrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let sm;
  while ((sm = srcsetRe.exec(html)) !== null) {
    const list = (sm[1] ?? sm[2] ?? '').split(',');
    for (const part of list) {
      const abs = absolutize(part.trim().split(/\s+/)[0], baseUrl);
      if (abs) assetLinks.add(abs);
    }
  }

  return { pageLinks: [...pageLinks], assetLinks: [...assetLinks] };
}

/* ----------------------------- robots.txt ------------------------------ */

function parseRobots(text, userAgent = 'webzip') {
  const groups = []; // { agents: [], rules: [{type, path}] }
  let current = null;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (!value) continue;

    if (field === 'user-agent') {
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((field === 'disallow' || field === 'allow') && current) {
      current.rules.push({ type: field, path: value });
    }
  }

  const ua = userAgent.toLowerCase();
  const matches = groups.filter((g) => g.agents.includes(ua));
  const chosen = matches.length ? matches : groups.filter((g) => g.agents.includes('*'));
  const rules = chosen.flatMap((g) => g.rules);

  return function isAllowed(pathname) {
    let best = null;
    for (const rule of rules) {
      if (rule.path === '/') {
        if (rule.type === 'disallow') best = best || { len: 1, allow: false };
        continue;
      }
      if (pathname.startsWith(rule.path) && (!best || rule.path.length > best.len)) {
        best = { len: rule.path.length, allow: rule.type === 'allow' };
      }
    }
    return best ? best.allow : true;
  };
}

/* ------------------------------- crawler -------------------------------- */

function createCrawler({ config, logger, safeFetch, filesDir, usedNames }) {
  const validate = (u) => validateUrl(u, config);

  async function loadRobots(origin, signal) {
    if (!config.respectRobots) return () => true;
    try {
      const res = await safeFetch.fetchSafe(new URL('/robots.txt', origin).toString(), {
        validate,
        signal,
        accept: 'text/plain,*/*;q=0.5'
      });
      const buf = await safeFetch.readBodyLimited(res, 262144, { signal });
      return parseRobots(buf.toString('utf8'), config.userAgent.split('/')[0]);
    } catch (err) {
      logger?.debug?.({ origin, err: err.message }, 'robots.txt unavailable — allowing all discovered links');
      return () => true;
    }
  }

  async function crawl({ startUrl, signal, budget, onState }) {
    const start = validate(startUrl);
    const origin = start.url.origin;
    const isAllowed = await loadRobots(origin, signal);

    /** @type {{url:string, depth:number}[]} */
    const queue = [{ url: start.urlString, depth: 0 }];
    const seen = new Set([start.urlString]); // queued OR already crawled
    const assetUrls = new Set();
    const pages = [];
    const truncations = [];
    const skipped = [];
    let htmlBytes = 0;
    let assetsTruncated = false;
    let droppedPages = 0;
    let droppedAssets = 0;

    while (queue.length && pages.length < config.maxPages) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

      // Running out of budget ends the crawl and is recorded as a truncation,
      // so job-service fails the job instead of returning a partial archive.
      if (budget.remaining <= 0) {
        logger?.info?.({ pages: pages.length }, 'crawl stopped: MAX_TOTAL_SIZE budget exhausted');
        truncations.push({ limit: 'MAX_TOTAL_SIZE', detail: `${budget.remaining} bytes left, ${queue.length} page(s) still queued` });
        break;
      }

      const { url, depth } = queue.shift();

      onState?.('CRAWLING', { page: url, pages: pages.length + 1 });

      let res;
      try {
        res = await safeFetch.fetchSafe(url, { validate, signal, accept: 'text/html,*/*;q=0.8' });
      } catch (err) {
        if (err.name === 'AbortError' || err.name === 'SizeLimitError') throw err;
        // The start page must succeed; a failing sub-page is simply skipped.
        if (pages.length === 0) throw err;
        logger?.debug?.({ url, err: err.message }, 'skipping unreachable page');
        skipped.push({ url, reason: err.message });
        continue;
      }

      if (!/^text\/html|^application\/xhtml/.test(res.contentType)) {
        // Not a page (e.g. the root URL served a PDF): archive it as an asset.
        const entry = uniqueEntryName(urlToEntryName(res.url), usedNames);
        const diskPath = assertInside(filesDir, path.join(filesDir, entry));
        // An extensionless URL maps to "<name>/index.html", so the parent
        // directory may not exist yet.
        await fsp.mkdir(path.dirname(diskPath), { recursive: true });
        const cap = Math.min(config.maxFileSize, Math.max(1, budget.remaining));
        try {
          const { size } = await safeFetch.pipeBodyToFile(res, diskPath, cap, { signal });
          budget.remaining -= size;
          assetUrls.delete(res.url.toString());
          pages.push({ url: res.url.toString(), entryName: entry, diskPath, size, contentType: res.contentType, isPage: false });
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          if (err.name === 'SizeLimitError') {
            // Over the cap: a limit-driven truncation, not a benign skip.
            logger?.info?.({ url, cap }, 'resource exceeds MAX_FILE_SIZE');
            truncations.push({ limit: 'MAX_FILE_SIZE', detail: `${url} exceeds ${cap} bytes` });
          } else {
            logger?.warn?.({ url, err: err.message }, 'resource skipped after a write failure');
            skipped.push({ url, reason: err.message });
          }
        }
        continue;
      }

      const cap = Math.min(config.maxFileSize, Math.max(1, budget.remaining));
      let buf;
      try {
        // The cap counts decompressed bytes, so a gzipped bomb cannot slip in.
        buf = await safeFetch.readBodyLimited(res, cap, { signal });
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        if (pages.length === 0) throw err; // the start page must fit, else 502
        if (err.name === 'SizeLimitError') {
          logger?.info?.({ url, cap }, 'page exceeds MAX_FILE_SIZE');
          truncations.push({ limit: 'MAX_FILE_SIZE', detail: `${url} exceeds ${cap} bytes` });
        } else {
          logger?.warn?.({ url, err: err.message }, 'page skipped after a read failure');
          skipped.push({ url, reason: err.message });
        }
        continue;
      }

      const entry = uniqueEntryName(urlToEntryName(res.url), usedNames);
      const diskPath = assertInside(filesDir, path.join(filesDir, entry));
      await fsp.mkdir(path.dirname(diskPath), { recursive: true });
      await fsp.writeFile(diskPath, buf);

      htmlBytes += buf.length;
      budget.remaining -= buf.length;
      pages.push({ url: res.url.toString(), entryName: entry, diskPath, size: buf.length, contentType: res.contentType, isPage: true });

      if (depth >= config.maxDepth) continue;

      const html = buf.toString('utf8');
      const { pageLinks, assetLinks } = extractLinks(html, res.url.toString());

      // Assets: drop duplicates first, so hitting MAX_ASSETS is only reported
      // when genuinely new assets had to be discarded.
      const newAssets = assetLinks.filter((a) => !assetUrls.has(a));
      const assetSlots = Math.max(0, config.maxAssets - assetUrls.size);
      if (newAssets.length > assetSlots) {
        assetsTruncated = true;
        droppedAssets += newAssets.length - assetSlots;
      }
      for (const asset of newAssets.slice(0, assetSlots)) assetUrls.add(asset);

      // Pages: filter to real candidates first (same origin, robots-allowed,
      // not already queued/crawled) so MAX_PAGES truncation is exact and never
      // a false alarm about links we would have skipped anyway.
      const candidates = [];
      for (const link of pageLinks) {
        let parsed;
        try { parsed = new URL(link); } catch (_) { continue; }
        if (!config.crossOriginPages && parsed.origin !== origin) continue;
        if (!isAllowed(parsed.pathname)) {
          logger?.debug?.({ link }, 'skipped by robots.txt');
          continue;
        }
        if (seen.has(link)) continue;
        candidates.push(link);
      }

      const pageSlots = Math.max(0, config.maxPages - (pages.length + queue.length));
      if (candidates.length > pageSlots) {
        droppedPages += candidates.length - pageSlots;
      }
      for (const link of candidates.slice(0, pageSlots)) {
        seen.add(link);
        queue.push({ url: link, depth: depth + 1 });
      }
    }

    if (droppedPages > 0 || (pages.length >= config.maxPages && queue.length > 0)) {
      truncations.push({
        limit: 'MAX_PAGES',
        detail: `${droppedPages + queue.length} more page(s) than MAX_PAGES=${config.maxPages} at depth <= ${config.maxDepth}`
      });
    }
    if (assetsTruncated) {
      truncations.push({ limit: 'MAX_ASSETS', detail: `${droppedAssets} more asset(s) than MAX_ASSETS=${config.maxAssets}` });
    }

    return {
      startUrl: start.urlString,
      origin,
      pages,
      truncations,
      skipped,
      assetUrls: [...assetUrls].slice(0, config.maxAssets),
      stats: { pages: pages.length, htmlBytes, discoveredAssets: assetUrls.size, skippedPages: skipped.length }
    };
  }

  return { crawl, extractLinks, parseRobots };
}

module.exports = { createCrawler, extractLinks, parseRobots };
