# pagesnap

A full-page screenshot crawler for JavaScript-rendered websites. Paste a URL into the UI, and it drives a real Chromium browser via Playwright, waits until the page is genuinely finished rendering, and saves a complete top-to-bottom PNG locally.

Built to handle the hard case: sites where the content isn't in the initial HTML, images lazy-load on scroll, and animations are mid-flight when a naive screenshot fires.

---

## Quick start

```bash
cd ~/Desktop/pagesnap && npm start
```

### Setting it up on another machine

Anyone with Node.js 18+ can run this. From the project folder:

```bash
npm install && npx playwright install chromium
```

`npm install` pulls the three dependencies; `npx playwright install chromium` downloads the browser binary itself (~150MB), which is **not** included in the project folder. Then `npm start` as above.

Nothing else is needed — no API keys, no accounts, no system Chrome. It runs entirely on the local machine and only talks to the sites being captured.

Then open **http://localhost:3000**, paste a URL, hit **Capture**.

Screenshots are written to `screenshots/` as `<domain>-<timestamp>.png`.

From the terminal instead:

```bash
node cli.js https://www.flowhunt.io/
```

---

## Deploying it (Railway)

The app is a long-running server that drives a real browser and writes large files, so it needs a **container** host, not a serverless one. Railway, Render, Fly.io and any plain VPS all work. **Vercel and Netlify do not** — their functions cap execution at 10–300s (a tall mobile capture exceeds that), have no persistent disk, and can't ship a full Chromium.

A `Dockerfile` and `railway.json` are included. To deploy:

```bash
npm i -g @railway/cli
railway login
railway init
railway up
```

Then set the login, the FlowHunt credentials, and generate a public URL:

```bash
railway variables --set PAGESNAP_USERNAME=kpmg --set PAGESNAP_PASSWORD=your-long-passphrase-here \
  --set FLOWHUNT_API_KEY=... --set FLOWHUNT_WORKSPACE_ID=... --set FLOWHUNT_FLOW_ID=...
railway domain
```

`railway domain` prints the live URL. The first build takes 5–10 minutes — it downloads Chromium and its system libraries.

### Login

The server reads these environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PAGESNAP_USERNAME` | *(unset)* | Username for the sign-in page. |
| `PAGESNAP_PASSWORD` | *(unset)* | Password, at least 12 characters. Set together with the username. |
| `PAGESNAP_SESSION_SECRET` | *(unset)* | Optional. Change it to sign every browser out without changing the password. |

Sign-in is a cookie session behind a normal login form, not HTTP Basic Auth. It covers everything: the UI, every `/api` route, the saved PNGs and the batch ZIP exports. Passwords are compared in constant time, the cookie is `httpOnly` and `sameSite`, and five wrong attempts from one address lock the form for 15 minutes.

The login is **mandatory** — the server refuses to start without it — whenever `FLOWHUNT_API_KEY` is set or the app is running on a host (Railway is detected automatically). Without that rule, anyone with the URL could run the KPMG flow on your FlowHunt credits and download the exports. Locally, with no FlowHunt key, it stays optional so a plain screenshot run needs no setup.

To run locally with a login:

```bash
PAGESNAP_USERNAME=kpmg PAGESNAP_PASSWORD=a-long-passphrase npm start
```

or put the same two lines in `.env`, which `npm start` loads.

**Set the login before generating a public domain**, not after.

### Persistent screenshots and exports

Container filesystems are wiped on every redeploy. To keep captures and batch ZIPs, mount a Railway volume at `/app/data` — the Dockerfile points both `SCREENSHOT_DIR` and `BATCH_DIR` under it. A batch interrupted by a redeploy can then be resumed instead of restarted.

Be aware these files are large: one company's batch folder is 2–10 MB as JPEG, a single-URL PNG capture can be 20–40 MB. Size the volume for the runs you plan.

Batch output does **not** grow without bound. Everything a run produces lives in one fixed directory, `batches/work/`, which is emptied when a different company list is loaded; each company's folder is emptied before that company is captured; and the export is a single `batches/batch.zip` overwritten on every build. Disk use is capped at roughly one run, whatever else happens. On startup the server also deletes the timestamped zips and `run-<hash>` folders older versions left behind.

The Dockerfile sets `PAGESNAP_MAX_SCALE=1`. At 2x, stitching a tall page can need several GB of RAM and gets the container OOM-killed; set it to 2 only on a plan with plenty of memory.

---

## Batch runs

The Batch tab takes a CSV of companies and a FlowHunt flow. The CSV is loaded straight into a table — one row per company, showing its own columns — before anything is sent anywhere, so you see what will run before running it.

From there:

- **Run all** captures every row; **Run unfinished** picks up the ones that are not done, which is how you continue an interrupted run.
- **Run** / **Re-run** on a single row does that one company on its own. Its folder is emptied first, so a re-run replaces its screenshots rather than adding to them.
- **Parallel runs** (1–10) is how many companies are captured at the same time. Each holds its own browser, so 3–4 suits a laptop and 10 needs the RAM to match. The ceiling is enforced on the server, not just in the input.
- **Details** on a row shows what the flow decided and what was captured — pages found, product screenshots, the business summary, and any warnings. There is no log to read.
- Every company gets its homepage, its about-us page and **up to six product pages**. That cap is fixed, not a setting: uncapped runs made the time for a list impossible to predict, and a per-run knob only moved that problem into the UI. Where a company has more, the row's `warnings` column says how many were found (`23 product pages found, captured first 6`), so a capped row is never read as a company that only sells six things.
- **Build ZIP** assembles `results.xlsx` and one ZIP from whatever has finished. It can be pressed mid-run, and again after re-running a failed row.

The run belongs to the server, not to the browser tab: closing the tab, reloading, or coming back an hour later all pick the run back up, and a restart mid-run comes back with the finished rows still marked finished.

| Route | Does |
|---|---|
| `POST /api/batch/job` | Creates (replaces) the job from the parsed CSV. |
| `GET /api/batch/job` | The current job — one status and one detail per row. Polled by the UI. |
| `POST /api/batch/job/:id/run` | Runs the whole list, or just the rows in `indexes`. Returns immediately. |
| `POST /api/batch/job/:id/stop` | Asks the run to stop after the companies in flight finish. |
| `POST /api/batch/job/:id/export` | Builds `results.xlsx` and `batches/batch.zip`. |

The FlowHunt API key is sent to the server and never comes back out — the job state the UI polls carries no settings at all.

---

## The viewport width option

The dropdown is **not** a crop or an output size — it is the width of the browser window the page is rendered in, before anything is captured. Because sites are responsive, that width decides which layout the site actually serves, so it changes what the screenshot contains.

| Option | What it renders | When to use it |
|---|---|---|
| **Desktop — 1440px** | The standard desktop layout most sites are designed and tested against. | The default. Use it unless you have a reason not to. |
| **Large desktop — 1920px** | Wide-monitor layout. Sites with a fixed max-width container just gain empty margin; grid-based sites may show an extra column. | Checking how a design holds up on a large monitor. |
| **Laptop — 1280px** | A smaller desktop breakpoint. Often where sidebars collapse and nav items start moving into an overflow menu. | Catching layout that breaks between desktop and tablet. |
| **Mobile — 390px** | The phone layout (iPhone-sized): hamburger nav, stacked cards, and usually a **much** taller page. | Capturing the mobile design. Expect more slices and a longer capture. |

Height is never chosen — it is always the page's own full scroll height, whatever that turns out to be at the selected width.

---

## The problem this solves

Ask Playwright for a screenshot the obvious way:

```js
await page.goto(url);
await page.screenshot({ path: 'out.png', fullPage: true });
```

…and on a modern site you get a broken image: grey placeholder boxes where lazy images should be, sections that are half-faded mid-animation, a cookie banner covering the top third, and — on tall pages — large bands of pure white.

Everything below exists to fix one of those failure modes.

---

## Architecture

| File | Role |
|---|---|
| `capture.js` | The engine. Owns the browser and the stabilisation pipeline. |
| `stitch.js` | Scroll-and-stitch capture — the part that actually produces the image. |
| `server.js` | Express server. Streams a single capture as newline-delimited JSON; serves the batch job API. |
| `batch.js` | One company end to end (`captureCompany`) and the XLSX + ZIP deliverable (`buildExport`). |
| `jobs.js` | The background batch job: holds the run, works through it at up to 10 companies at a time. |
| `public/index.html` | The UI — URL box, viewport selector, inline preview, and the batch table. |
| `cli.js` | Terminal runner, for fast iteration without the UI. |
| `verify.js` | Validation tool. Renders evenly-spaced crops of a capture to eyeball. |
| `blankcheck.js` | Validation tool. Reports blank horizontal bands as a % of page height. |

The last two matter more than they look. A capture that *reports* success can still be visually broken — the whole point is that you can't trust the pipeline's own logs. See "How this was validated" below.

---

## The stabilisation pipeline

Ten ordered steps run between `goto` and the shutter. Each is independently fallible: a step that throws is logged and skipped rather than killing the capture.

**1. Navigate** — with `waitUntil: 'domcontentloaded'`, deliberately *not* `networkidle`. News sites keep analytics and ad sockets open indefinitely, so `networkidle` would simply hang. Settling is handled explicitly in step 4.

**2. Bot-check interstitial** — sme.sk sits behind Cloudflare and serves a "Just a moment…" challenge page for the first few seconds. If we screenshot immediately, we capture the challenge, not the site. Detected by title and waited out, up to 40s.

**3. Consent / cookie wall** — otherwise it covers the shot. Tries a list of known CMP selectors (Didomi, OneTrust, Cookiebot, Usercentrics), preferring the **reject-all** control, then falls back to matching visible button text in Slovak, Czech and English.

**4. Network settle** — bounded `networkidle` wait with a 12s ceiling, then proceed regardless. Never blocks forever.

**5. Un-lazy** — promotes `data-src` → `src` and `data-srcset` → `srcset`, and flips every image to `loading="eager"`. Catches images whose lazy-loader never fires.

**6. Scroll passes** — sweeps to the bottom in viewport-sized steps with pauses so `IntersectionObserver`s fire, then repeats until the page height stops growing for two consecutive passes. Capped at 60 rounds / 60000px so an infinite-scroll feed can't run forever; when the cap is hit the UI says so rather than pretending the capture is complete.

**7. Fonts, then images** — waits `document.fonts.ready` so text isn't captured mid-webfont-swap, then waits for images with a **tolerant** strategy: it stops when progress stalls, not when everything is perfect. Third-party ad images frequently never resolve, so a strict "all images loaded" wait would time out on every news site.

**8. Freeze motion** — see the gotcha below.

**9. Settle** — back to top, then two `requestAnimationFrame`s so the compositor has painted a clean frame.

**10. Capture** — scroll-and-stitch. See below.

---

## Two bugs worth knowing about

Both of these produced captures that *looked* successful in the logs and were badly broken in reality.

### `fullPage: true` silently returns blank bands

Playwright's `fullPage` asks Chromium to rasterise the entire document into a single surface. Past roughly 16000px, Chromium quietly fails and returns **blank white bands instead of content** — no error, no warning.

flowhunt.io is ~13900 CSS px tall. At `deviceScaleFactor: 2` that's a 27700px surface, far over the limit. The capture reported `144/144 images loaded` and was **57% blank**.

**The fix is `stitch.js`:** scroll the page one viewport at a time, take a normal screenshot of each screen, and compose the slices into one tall image with `sharp`. No slice is ever taller than the viewport, so the limit never applies — and the full 2× retina scale is preserved rather than being scaled down to fit.

Two details make it seamless:
- Sticky and fixed elements are hidden after the first slice, so headers and floating chat widgets don't repeat down the image.
- The browser clamps `scrollTo` at the bottom of the page, so the final slice overlaps the previous one. It's cropped to just the remainder.

### Freezing animations can erase content

The obvious way to stop mid-animation capture is:

```css
* { animation-duration: 0s !important; }
```

This is a trap. It makes every animation complete instantly — and an animation whose `fill-mode` is `none` then **reverts to its base style**. For fade-in content that base style is `opacity: 0`, so the "fix" blanks out whole sections. The same applies to calling `.finish()` on a `getAnimations()` entry with `fill: none`.

The working approach holds animations at their **end** state instead of cancelling them: force `animation-fill-mode: forwards` with a 1ms duration, and call `updateTiming({ fill: 'forwards' })` before `.finish()`. Infinite animations can't finish, so they're paused instead.

Transitions are separately zeroed, `<video>` is paused, and the context runs with `reducedMotion: 'reduce'`.

---

## How this was validated

Not by trusting the pipeline's logs — they reported success on a 57%-blank image.

```bash
node blankcheck.js screenshots/<file>.png   # blank bands as % of page height
node verify.js     screenshots/<file>.png 5 # render 5 crops to /tmp for eyeballing
```

`blankcheck.js` draws the tall PNG scaled down into a small canvas (avoiding canvas size limits) and scans row by row for uniform-colour bands, reporting each as a percentage range of the page.

---

## Notes and limits

- **Infinite scroll** is capped at 60 passes / 60000px. When the cap is hit, the result carries `capped: true` and the UI shows a warning — a "full page" screenshot of an endless feed is undefined, so it's surfaced rather than hidden.
- **Unresolved images** are reported (`images: 140/144`). Stragglers are almost always third-party ad slots that never load in a headless browser.
- **Cloudflare** is waited out, not bypassed. If a site escalates to an interactive challenge, the capture will show it.
- The browser identifies itself with a normal desktop Chrome user-agent and `sk-SK` locale so sites serve their standard content.
