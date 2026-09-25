# WebZip — self-hosted website archiver (REST API)

Archive any website into a ZIP and stream it straight back over HTTP.

This repo holds both halves in one place:

- `index.html` — the frontend. **Untouched, byte for byte**, served as-is at `/`.
- `src/` — the Node.js backend that answers `POST /api/zip` in the exact shape the
  frontend already sends and expects.

The backend is a single Node process with no database, no build step, no WebSocket and
no shared filesystem. It is sized for a small container: **300 MB RAM, 700 MB disk,
one archive job at a time.**

---

## Quick start

```bash
npm install
npm start                 # node src/server.js  -> http://localhost:3000
```

```bash
curl -X POST http://localhost:3000/api/zip \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com"}' \
  --output example-com.zip
```

`.env` support: `node` does not read `.env` on its own, so the server parses it at
boot. Precedence is **real environment → `.env.<NODE_ENV>` → `.env`**. A variable that
already exists in the environment is never overwritten, so panel/host variables always
win. Copy `.env.production` (tuned for 300 MB / 700 MB) to `.env`, or set the same keys
in your panel.

---

## Deploying on Pterodactyl

| Panel field | Value |
|---|---|
| Startup command | `node src/server.js` |
| Docker image | any Node 18.17+ / 20 / 22 image (tested on Node 22) |
| Allocation | one port; the panel exports it as `SERVER_PORT` |
| Memory | 300 MB |
| Disk | 700 MB |
| Environment | paste the keys from `.env.production` |

The server binds `0.0.0.0` and reads the port from `PORT`, falling back to
`SERVER_PORT` (what Pterodactyl injects) and then to `3000`. Nothing else about the
runtime is assumed — no Docker-in-Docker, no root, no systemd.

A `Dockerfile` is included for non-Pterodactyl use. Its install step
(`npm ci --omit=dev`) is reproducible from the committed `package-lock.json`
(154 packages, 26 MB), and its `CMD` is the same `node src/server.js`.

**Recommended production environment** — the full annotated file is
[`.env.production`](.env.production):

```ini
NODE_ENV=production
HOST=0.0.0.0
PORT=                          # empty = use the panel's SERVER_PORT
MAX_CONCURRENT_JOBS=1
MAX_CONCURRENT_DOWNLOADS=3
MAX_PAGES=25
MAX_ASSETS=150
MAX_DEPTH=2
MAX_TOTAL_SIZE=104857600       # 100 MB per archive
MAX_FILE_SIZE=10485760         # 10 MB per file
MAX_RSS_MB=230
MAX_TEMP_DISK_MB=400
TEMP_DIR=/home/container/.webzip-tmp
RATE_LIMIT_MAX=6
TRUST_PROXY=0
JOB_TIMEOUT_MS=90000
```

### Resource budget

Peak scratch disk per job is `MAX_TOTAL_SIZE × 2` — the downloaded files plus the ZIP
being written beside them. With one job at a time that is 200 MB, so
`MAX_TEMP_DISK_MB=400` leaves headroom and the app, `node_modules` (26 MB) and logs fit
comfortably inside 700 MB. **The server enforces this at boot**: if
`MAX_TOTAL_SIZE × 2 × MAX_CONCURRENT_JOBS > MAX_TEMP_DISK_MB` it refuses to start
rather than discovering the problem mid-job.

Memory is streamed, not buffered: pages are capped at `MAX_FILE_SIZE` on the way in,
assets are piped straight to disk, and the ZIP is written by `archiver` and then sent
with `fs.createReadStream`. The only whole-file buffer in the process is one HTML page
(it has to be parsed to find links). `MAX_RSS_MB` is a last-resort admission guard —
when the process exceeds it, new jobs get `502` instead of pushing the container into
OOM. The Node heap size is never raised to hide this.

---

## API

### `POST /api/zip`

```json
{ "url": "https://example.com" }
```

`200` — the ZIP as a raw binary body:

```
Content-Type:        application/zip
Content-Disposition: attachment; filename="example-com-OnlyF!xaDev.zip"
Content-Length:      <bytes>
X-File-Name:         example-com-OnlyF!xaDev.zip
X-Source-URL:        https://example.com
```

Errors — always JSON, always the same shape:

```json
{
  "error":     "That address is in a blocked network range.",
  "isError":   true,
  "code":      "INVALID_URL",
  "message":   "That address is in a blocked network range.",
  "requestId": "c7f62cd7"
}
```

`error` is a human-readable **string** so the frontend's
`throw new Error(err.error)` produces a useful toast.

| Status | `code` | When |
|---|---|---|
| `400` | `INVALID_URL` | missing/empty `url`, not http(s), URL credentials, blocked host or IP, port not in `ALLOWED_PORTS`, URL too long, body too large or not JSON |
| `429` | `RATE_LIMITED` | more than `RATE_LIMIT_MAX` requests per IP per window |
| `502` | `ARCHIVE_START_FAILED` | target unreachable, DNS failure, connection reset, over-capacity, memory/disk pressure, **or `LIMITS_EXCEEDED`** (see below) |
| `504` | `JOB_TIMEOUT` | the job passed `JOB_TIMEOUT_MS` |
| `500` | `INTERNAL_ERROR` | unexpected faults only |

**A `200` always means a complete archive.** If any configured limit cut the job short
(`MAX_PAGES`, `MAX_ASSETS`, `MAX_TOTAL_SIZE`, `MAX_FILE_SIZE`), the request fails with
`502` and a message naming the limits that were hit — the server never streams a
partial ZIP and pretends it succeeded. Sub-resources that are simply *unreachable*
(one dead image, one 500 on a sub-page) are skipped and logged, because a site with a
broken image is still fully archived.

### Other endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health` | liveness — `{"status":"ok","uptime":<s>}`. Use this for the panel's health check. |
| `GET /api/health` | readiness — adds `activeJobs`, `maxConcurrentJobs`, `storageUsedMb` |
| `GET /` and `GET /index.html` | the untouched frontend |

There is no other public endpoint. The frontend is served by explicit routes only —
never `express.static` on the repo root — so `src/`, `.env` and `node_modules` are not
reachable over HTTP.

---

## Configuration

Every variable is read and validated **once** at boot by `src/config/config.js`.
Nothing downstream touches `process.env`. Invalid values, and combinations that cannot
work, abort the boot with a clear message instead of failing later.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | listen port; falls back to `SERVER_PORT` (Pterodactyl) |
| `HOST` | `0.0.0.0` | bind address |
| `NODE_ENV` | — | `production` enables the production guards |
| `LOG_LEVEL` | `info` | pino level |
| `TRUST_PROXY` | `0` | trusted proxy hops. `true` is **rejected at boot** |
| `REQUEST_BODY_LIMIT` | `16kb` | JSON body cap |
| `MAX_PAGES` | `25` | HTML pages per archive |
| `MAX_ASSETS` | `150` | css/js/img/font files per archive |
| `MAX_DEPTH` | `2` | link depth from the start page |
| `CROSS_ORIGIN_PAGES` | `false` | follow links to other hosts |
| `RESPECT_ROBOTS` | `true` | honour `robots.txt` disallow rules |
| `USER_AGENT` | `WebZip/1.0 (+self-hosted website archiver)` | sent to every target |
| `MAX_TOTAL_SIZE` | `104857600` | total bytes per archive (100 MB) |
| `MAX_FILE_SIZE` | `10485760` | per-file cap (10 MB), counted **decompressed** |
| `MAX_URL_LENGTH` | `2048` | request URL length cap |
| `REQUEST_TIMEOUT_MS` | `12000` | per-request timeout (connect + body) |
| `JOB_TIMEOUT_MS` | `90000` | hard cap on a whole job |
| `MAX_REDIRECTS` | `5` | redirect chain limit, re-validated per hop |
| `MAX_CONCURRENT_JOBS` | `1` | archive jobs at once |
| `MAX_CONCURRENT_DOWNLOADS` | `3` | parallel asset downloads per job |
| `ADMISSION_QUEUE_TIMEOUT_MS` | `1500` | how long an over-capacity request waits before `502` |
| `RATE_LIMIT_WINDOW_MS` | `60000` | rate-limit window |
| `RATE_LIMIT_MAX` | `6` | requests per IP per window |
| `ALLOWED_PORTS` | `80,443` | the only ports a target URL may use |
| `MAX_RSS_MB` | `230` | refuse new jobs above this RSS |
| `MAX_TEMP_DISK_MB` | `400` | refuse new jobs when `TEMP_DIR` exceeds this |
| `TEMP_DIR` | `/tmp/webzip` | scratch space; see the warning below |
| `CLEANUP_SWEEP_INTERVAL_MS` | `120000` | stale-directory sweep interval |
| `FILENAME_SUFFIX` | `OnlyF!xaDev` | `<hostname>-<suffix>.zip` |
| `SSRF_ALLOW_LOOPBACK` | `false` | test-only hatch; refused in production |

`TEMP_DIR` must be a **dedicated empty directory**. The startup sweep deletes
everything inside it, so a `TEMP_DIR` that is a filesystem root, the working directory,
or a parent of `index.html` is rejected at boot.

---

## Security model

**SSRF** — every URL is validated before any socket is opened, and the validated IP is
*pinned* to the connection:

- schemes: only `http` and `https`
- URL credentials (`http://user:pass@host`) rejected
- blocked IPv4: `127.0.0.0/8` (loopback), `10.0.0.0/8`, `172.16.0.0/12`,
  `192.168.0.0/16` (private), `169.254.0.0/16` (link-local, incl. the cloud metadata
  address `169.254.169.254`), `100.64.0.0/10` (CGNAT), `0.0.0.0/8`, `192.0.0.0/24`
  (reserved), `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` (documentation),
  `198.18.0.0/15` (benchmarking), `255.255.255.255/32`, `240.0.0.0/4`
- blocked IPv6: `::1/128`, `fc00::/7` (covers `fd00::/8`), `fe80::/10`, `ff00::/8`,
  `::/128`, `2001:db8::/32`, NAT64 `64:ff9b::/96`, discard `100::/64`
- blocked hostnames: anything ending in `.localhost`, `.local`, `.internal`,
  `.localdomain`, `.invalid` or `.lan`, plus `localhost`, `metadata`, `instance-data`,
  `metadata.google.internal`, `metadata.tencentyun.com`, `metadata.azure.internal` and
  the AWS IPv6 metadata address `fd00:ec2::254`
- ports outside `ALLOWED_PORTS` rejected
- **DNS rebinding**: the name is resolved once; the connection uses that pinned IP and
  never re-resolves. A resolver that returns a blocked address is overruled.
- **redirects** are re-validated hop by hop, so a public host cannot bounce the crawler
  into a private range
- **ZIP traversal**: every entry name is normalised and containment-checked, so
  `../../etc/passwd` style paths and absolute paths cannot be written or read

**Abuse control** — per-IP rate limit on `/api/zip` only, one job at a time, a bounded
admission queue, and hard caps on body size, URL length, page count, asset count,
per-file size, total size, redirects, request time and total job time.

**Client IP** — `TRUST_PROXY` defaults to `0`, so the socket address is the client.
`TRUST_PROXY=true` is rejected at boot because it would let any caller spoof
`X-Forwarded-For` and dodge the rate limiter. Set it to `1` (or the proxy's IP/CIDR)
only if a real reverse proxy in front of this process rewrites that header. Both
behaviours are covered by tests.

**No `Content-Security-Policy` is sent**, deliberately: the untouched frontend uses an
inline `<script>`, inline `onclick` handlers and inline `style` attributes, so a strict
CSP would break it. `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`
and `Referrer-Policy: no-referrer` are sent instead. Access logs record method, path,
status and duration only — no bodies, no headers, no cookies, and query strings are
stripped.

---

## Lifecycle and cleanup

A job gets `TEMP_DIR/<jobId>/`, downloads into `files/`, writes `archive.zip` beside it,
and the directory is removed when the response closes — on success, on error, on
timeout and on client disconnect (which also aborts the crawl instead of wasting
bandwidth on a response nobody will read).

Three further nets exist because a process can die at any moment:

1. **boot sweep** — everything inside `TEMP_DIR` is orphaned by definition when a fresh
   process starts, so it is deleted
2. **periodic sweep** — directories older than `JOB_TIMEOUT_MS` with no live job
3. **per-job force timer** — reclaims a job whose response never reported completion

`SIGTERM`/`SIGINT` stop accepting connections, drain in-flight work, clean up and exit
`0`. `unhandledRejection` and `uncaughtException` are logged at `fatal` and exit `1`, so
the panel restarts the process instead of leaving a zombie.

---

## Tests

```bash
npm test          # 116 tests, ~10 s
npm run test:unit
npm run test:integration
npm run test:frontend
```

| Suite | Tests | Covers |
|---|---|---|
| `tests/unit/` | 77 | config validation + boot refusals, URL validation, SSRF range classification, DNS rebinding with an injected resolver, crawler, filename/ZIP-path safety, error mapping |
| `tests/integration/` | 35 | full HTTP cycles against a local fixture site, every documented status code, ZIP integrity (`unzip -t` and entry listing), limits → `502`, rate limiting, `TRUST_PROXY` spoofing, semaphore release after `504`, client abort, orphan sweep, memory/RSS/disk guards, leak detection over repeated jobs, crash + signal behaviour in real child processes |
| `tests/frontend-compat/` | 4 | the **actual** `<script>` from `index.html`, extracted and executed, against the real API |

ZIP output is verified with the system `unzip -t` where available, plus entry-path
assertions, so a corrupt or traversal-laden archive cannot pass.

---

## Known limitations

- **One job at a time** on 300 MB. Extra requests wait up to 1.5 s, then get `502`.
  Raising `MAX_CONCURRENT_JOBS` requires raising `MAX_TEMP_DISK_MB` to match — the
  boot check tells you if they disagree.
- **90 s per job** is a hard ceiling; a very large site fails with `504` rather than
  running forever.
- **`robots.txt`** is fetched once per job for the start origin (capped at 256 KB) and
  is not cached across jobs. If it cannot be fetched, all discovered links are allowed.
- **Progress** is not reported to the client (no WebSocket by design); the frontend
  animates an estimate and the ZIP arrives in one response.
- JavaScript-rendered sites are archived as their server-side HTML; there is no
  headless browser.
