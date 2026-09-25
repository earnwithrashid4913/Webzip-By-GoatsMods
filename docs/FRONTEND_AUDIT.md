# Frontend audit — `index.html`

**`index.html` has not been modified.** It is byte-for-byte identical to the version
that was checked out:

```
md5     71a1ae6cfd28555c91c0b48eed502532
sha256  268e9f6c66646e22b5ac606203b0c305637e2a8daa744590576c9b48e546c4a2
size    27761 bytes (569 lines)
```

This document lists every bug and animation problem found in it, with exact line
numbers and a ready-to-paste patch for each one. **Nothing here has been applied** —
apply whichever items you want, in your own copy, when you are ready. Line numbers
refer to the current file.

Channel links, channel names and the `??` avatar placeholders (lines 320, 328, 340)
are left exactly as they are, as you asked — they are yours to fill in.

---

## 1. Functional bugs

### B1 — Pressing Enter twice fires two archive jobs (HIGH)

`index.html:440`

```js
document.getElementById('url-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') downloadZip();
});
```

`downloadZip()` sets `btn.disabled = true` (line 456) but never checks it on entry, so
the Enter handler can start a second job while the first is still running. The second
request then gets `502` (over capacity) or `429` (rate limit) and shows an error toast
even though the first download succeeds.

```js
let busy = false;
async function downloadZip() {
  if (busy) return;
  busy = true;
  try {
    /* ...existing body... */
  } finally {
    busy = false;
    btn.disabled = false;
    btn.innerHTML = '...';
  }
}
```

### B2 — The blob URL is never released (HIGH — browser memory)

`index.html:443`, `450`, `497`

`currentBlobUrl` is only revoked at the start of the *next* download. Until then the
whole ZIP stays resident in the tab. With the backend's 100 MB per-archive ceiling, a
user who archives a few sites in one session can hold hundreds of MB in one tab, and a
page refresh is the only thing that frees it.

Revoke it after the download has been handed to the browser — but not immediately, or
the visible Download button stops working:

```js
setTimeout(() => {
  if (currentBlobUrl) { URL.revokeObjectURL(currentBlobUrl); currentBlobUrl = null; }
  dlBtn.href = '#';
}, 60000);
```

### B3 — No timeout or cancel on the request (HIGH — UI can appear frozen)

`index.html:478`

```js
const res = await fetch(BASE + '/api/zip', { ... });
```

There is no `AbortController`. If the connection stalls, the button stays on
"Archiving..." until the *browser's* own timeout (often 300 s) and the user has no way
to cancel. The backend caps a job at 90 s, so the frontend should match:

```js
const ctrl = new AbortController();
const t = setTimeout(() => ctrl.abort(), 120000);
try {
  const res = await fetch(BASE + '/api/zip', { method:'POST', signal: ctrl.signal, ... });
  /* ... */
} catch (e) {
  toast(e.name === 'AbortError' ? 'Timed out — the site is too slow.' : 'Error: ' + e.message, 'err');
} finally {
  clearTimeout(t);
}
```

### B4 — The automatic download is blocked after a slow archive (MEDIUM)

`index.html:507-511`

```js
setTimeout(() => { ...; dlBtn.click(); ... }, 300);
```

Browsers only allow a programmatic `click()` while *transient user activation* is
alive, which expires a few seconds after the user's gesture. An archive that takes
30 s has long lost it, so Chrome/Firefox silently drop the click. The result panel and
its Download button still appear, so the user is not stuck — but the "it downloads by
itself" behaviour only works on fast archives.

Keep the click (it is harmless when allowed), but make the panel the primary path and
say so in the toast:

```js
toast('✓ ' + fileName + ' ready — click Download if it did not start.', 'ok');
```

### B5 — Copy button fails silently on plain HTTP (MEDIUM)

`index.html:536-540`

```js
navigator.clipboard.writeText(BASE).then(() => { ... });
```

`navigator.clipboard` is `undefined` on insecure origins. A Pterodactyl allocation
reached over `http://ip:port` (no TLS) therefore throws an unhandled rejection, the
button stays on "Copy", and the console shows an error. Add a fallback:

```js
function copyBase(btn) {
  const done = () => { btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 1500); };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(BASE).then(done).catch(() => legacyCopy(done));
  } else legacyCopy(done);
}
function legacyCopy(done) {
  const ta = document.createElement('textarea');
  ta.value = BASE; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) {}
  ta.remove();
}
```

### B6 — The docs show three different filename suffixes (MEDIUM — confusing)

`index.html:363`, `380`, `390`, `392`, `502`, `540`

| Line | Text shown to the user |
|---|---|
| 363 | `<hostname>-OnlyF!xaDev.zip` |
| 380 | `filename="example-com-OnlyFixaDev.zip"` |
| **390** | `filename="example-com-OnlyFixa.zip"` ← different again |
| 392 | `X-File-Name: example-com-OnlyFixaDev.zip` |
| 502 | JS fallback `'archive-OnlyFixaDev.zip'` |
| 540 | `--output example-com-OnlyFixaDev.zip` |

The backend produces exactly one suffix, controlled by the `FILENAME_SUFFIX`
environment variable (default `OnlyF!xaDev`, matching line 363 — the sentence a human
actually reads). Pick one spelling, set `FILENAME_SUFFIX` to it, and make all six
places agree. Until then the docs contradict the file the user receives.

### B7 — The documented error codes omit 429 (LOW)

`index.html:398-403`

The grid documents 400 / 502 / 504 / 500. The backend also returns
`429 RATE_LIMITED` (default: 6 requests per minute per IP). The UI still works — it
reads the `error` string — but the docs should list it:

```html
<div class="ec ecode">429</div><div class="ec emsg">Too many requests — wait a minute</div>
```

Also worth adding: `502` now also covers `LIMITS_EXCEEDED`, i.e. a site too large for
the configured limits. That message is worth showing verbatim, which the UI already
does.

### B8 — `dl-btn` starts as `href="#"` (LOW)

`index.html:302` — before the first successful archive, clicking Download jumps the
page to the top. Use `href="javascript:void(0)"`-free markup instead:
`<a class="dl-btn" id="dl-btn" role="button" aria-disabled="true">` and set `href`
only when a blob exists.

### B9 — External font dependency (LOW)

`index.html:5` loads Inter and JetBrains Mono from `fonts.googleapis.com` with
`display=swap`. That is correct, but it is a third-party request on every page view,
and on a network that cannot reach Google the UI silently falls back to system fonts.
If you want the look to be identical everywhere, self-host the two WOFF2 files.

---

## 2. Animation and visual-stability problems

### A1 — `transition: all` makes theme switching cascade (HIGH — the visible "jitter")

`index.html:50`, `87`, `93`, `124`, `147`, `177`, `205`

Seven rules use `transition:all 0.2s`. Clicking the theme button changes every CSS
custom property at once, so *every* transitionable property on *every* element starts
a 0.2 s animation simultaneously — backgrounds, borders, gradients, shadows. On a
phone this drops frames and looks like the whole page ripples.

Fix without touching each rule — freeze transitions for one frame while the theme
swaps:

```js
function cycleTheme() {
  document.documentElement.classList.add('theming');
  themeIdx = (themeIdx + 1) % THEMES.length;
  /* ...existing body... */
  requestAnimationFrame(() => requestAnimationFrame(() =>
    document.documentElement.classList.remove('theming')));
}
```

```css
.theming *, .theming *::before, .theming *::after { transition: none !important; }
```

### A2 — Toast fade-out usually does not animate (HIGH — "animation not smooth")

`index.html:549`

```js
el.style.opacity = '0'; el.style.transition = 'opacity 0.3s';
```

Both are set in the same tick, so the browser resolves the new `opacity` in a style
recalculation where `transition` was not yet in effect — the toast disappears
instantly instead of fading. Set the transition first, then change the value on the
next frame:

```js
el.style.transition = 'opacity 0.3s ease';
requestAnimationFrame(() => { el.style.opacity = '0'; });
setTimeout(() => el.remove(), 320);
```

### A3 — The progress bar steps instead of gliding (MEDIUM)

`index.html:105`, `462-473`

The bar uses `transition:width 0.4s ease` while JS pushes a new width every
**1200 ms**. The bar animates for 0.4 s, then sits still for 0.8 s — a visible stutter
repeated ~30 times. Match the transition to the tick:

```css
transition:width 1.2s linear;
```

Better still, tick every 200 ms with `fakePct += Math.random() * 0.5` — the motion
becomes continuous and the fake ceiling of 88 % is reached at the same wall-clock time.

### A4 — Nothing respects `prefers-reduced-motion` (MEDIUM — accessibility)

The pulse (`animation:pls 2s infinite`, line 65) and the spinner
(`animation:spin .7s linear infinite`, line 217) run forever. Users who ask their OS
to reduce motion still get both. Add once, near the top of the stylesheet:

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

### A5 — The infinite pulse never idles (LOW — battery/CPU)

`index.html:65-66` — a permanently running animation keeps the compositor busy and
stops the page from ever going idle on a mobile browser. Since it is only a decorative
"live" dot, pause it when the tab is hidden:

```css
.hbadge .live { animation: pls 2s ease-in-out infinite; }
```

```js
document.addEventListener('visibilitychange', () => {
  document.querySelectorAll('.live').forEach(el =>
    el.style.animationPlayState = document.hidden ? 'paused' : 'running');
});
```

Note `ease-in-out` also removes the mechanical feel of the default `linear`-ish pulse.

### A6 — The result panel snaps away (LOW)

`index.html:111` — `.result-wrap.show` animates in (`animation:su 0.3s ease`) but
removing `.show` sets `display:none` immediately, so it vanishes. Either keep it
symmetric or accept the snap; a symmetric version needs a short timeout before hiding:

```js
rw.classList.add('hide');
setTimeout(() => { rw.classList.remove('show', 'hide'); }, 200);
```

```css
.result-wrap.hide { animation: su 0.2s ease reverse; }
```

### A7 — The clipped logo text can disappear (LOW)

`index.html:36-38`

```css
background:linear-gradient(135deg,var(--text) 0%,var(--accent) 100%);
-webkit-background-clip:text;-webkit-text-fill-color:transparent;
```

Only the `-webkit-` prefixed forms are present. Every browser that matters supports
them today, but if one ever does not, the fill is transparent with no clip and the word
"WebZip" becomes invisible. Cheap insurance:

```css
background-clip:text; color:transparent;
```

### A8 — Two fixed full-viewport gradient layers (LOW — mobile scroll jank)

`index.html:27-33` — `.bg-r` and `.bg-g` are both `position:fixed; inset:0` with
multi-stop gradients. They are `pointer-events:none` and do not scroll, but on
low-end Android they are repainted during scroll. If you see stutter while scrolling on
a phone, merge them into one element and add `will-change:transform`.

---

## 3. Things that are correct and should not be changed

Verified against the running backend:

- **`throw new Error(err.error || 'HTTP ' + res.status)`** (line 490) — the backend
  returns `error` as a human-readable string plus `isError: true`, `code`, `message`
  and `requestId`. The existing line produces a meaningful toast. No change needed.
- **`Content-Disposition` parsing** (line 494) — the frontend and the API are the same
  origin, so the header is readable without `Access-Control-Expose-Headers`. The
  backend also sends `X-File-Name` and `X-Source-URL` if you ever prefer them.
- **`BASE = window.location.origin`** (line 411) — correct for same-origin deployment.
  It only breaks if the file is opened from `file://`, which is not a supported way to
  run this.
- **No `Content-Security-Policy` is sent by the backend**, deliberately. This page
  relies on an inline `<script>`, inline `onclick` handlers (lines 236, 240) and inline
  `style` attributes, so a strict CSP would break it. The backend sends
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN` and
  `Referrer-Policy: no-referrer` instead.
- The theme persistence, the Escape-to-close handler, the toast auto-dismiss and the
  button state restoration in `finally` are all correct.

---

## 4. Suggested order if you apply these

1. **B1** (double submit) and **B3** (no timeout) — both are user-visible failures.
2. **A2** (toast fade) and **A1** (theme cascade) — the two things that make the UI
   feel unpolished.
3. **B2** (blob leak) and **A3** (progress stutter).
4. **B6** (filename suffix) — decide the spelling, then set `FILENAME_SUFFIX` to match.
5. The rest as time allows.

Every patch above is local; none of them changes the API contract, so the backend needs
no adjustment whichever ones you take.
