import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { scrollAndStitch } from './stitch.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Overridable so a container can point this at a mounted volume.
export const SHOTS_DIR = process.env.SCREENSHOT_DIR || path.join(__dirname, 'screenshots');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* Consent buttons, in preference order: reject-all first (privacy-preserving),
   then accept as a fallback so the overlay never survives into the screenshot. */
const CONSENT_SELECTORS = [
  '#didomi-notice-disagree-button',
  '.didomi-continue-without-agreeing',
  '#onetrust-reject-all-handler',
  'button[data-testid="uc-deny-all-button"]',
  '#CybotCookiebotDialogBodyButtonDecline',
  '#didomi-notice-agree-button',
  '#onetrust-accept-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  'button[aria-label*="Súhlas" i]',
  'button[mode="primary"]',
];

/* Split into two priority tiers (reject beats accept whenever both are on the
   page) so a single per-button pass can check "which tier, if any" instead of
   re-scanning every button once per pattern — see the note on
   findConsentMatch() below for why that re-scan was a real problem. */
const CONSENT_TEXTS_REJECT = [
  // Unanchored: real CMP buttons read like "Pokračovať s nevyhnutnými cookies →",
  // not a tidy leading keyword.
  /nevyhnutn|iba nevyhnutn|len nevyhnutn/i,   // sk: necessary-only
  /nesúhlas|odmietnu|pokračovať bez/i,        // sk: disagree / reject
  /odmítnout|nesouhlas|pouze nezbytn/i,       // cz
  /reject|decline|continue without|only necessary|essential only/i,
  /^\s*(nega|rifiuta|solo necessari|rifiuta tutto)/i,        // it: deny / refuse
  /^\s*(rechazar|denegar|s[oó]lo necesarias)/i,              // es
  /^\s*(refuser|tout refuser|n[ée]cessaires uniquement)/i,   // fr
  /^\s*(ablehnen|alle ablehnen|nur notwendige)/i,            // de
  /^\s*(recusar|rejeitar|apenas necess[aá]ri)/i,             // pt
  /^\s*(απ[oό]ρριψη|α[πρ]όρριψη ό[λ]ων)/i,                    // el
  /^\s*(noraid[īi]t|atteikties)/i,                           // lv
  /^\s*(odrzu[ćc]|odmów)/i,                                  // pl
  /^\s*(respinge|refuz)/i,                                   // ro
  /^\s*(zavrni|zavrne)/i,                                    // sl
  /^\s*(odm[íi]tnout v[šs]e)/i,                              // cs
  /^\s*(elutas[íi]t|nem fogadom el|csak a sz[üu]ks[ée]ges)/i, // hu
  /^\s*(weigeren|alles weigeren|alleen noodzakelijke)/i,     // nl
  /^\s*(afvis|afvis alle|kun n[øo]dvendige)/i,               // da
  /^\s*(avvisa|neka|endast n[öo]dv[äa]ndiga)/i,              // sv
  /^\s*(hylk[äa]|vain v[äa]ltt[äa]m[äa]tt[öo]m[äa]t)/i,      // fi
  /^\s*(keeldu|ainult vajalikud)/i,                          // et
  /^\s*(atmesti|tik b[ūu]tinus)/i,                           // lt
  /^\s*(отхвърл|откажи|само необходим)/i,                    // bg
  /^\s*(odbij|odbaci|samo nu[žz]ni)/i,                       // hr
];

const CONSENT_TEXTS_ACCEPT = [
  // Accept as a last resort, so the overlay never survives into the capture.
  /^\s*(súhlasím|súhlas|prijať|prijímam)/i,
  /^\s*(accept|agree|allow all|got it|ok)\s*$/i,
  /^\s*(accetta|accetto|ho capito)/i,                        // it
  /^\s*(aceptar|acepto)/i,                                   // es
  /^\s*(accepter|j'accepte|tout accepter)/i,                 // fr
  /^\s*(akzeptieren|alle akzeptieren|zustimmen)/i,           // de
  /^\s*(aceitar|aceito)/i,                                   // pt
  /^\s*(αποδοχ[ήη])/i,                                        // el
  /^\s*(piekr[īi]tu|apstiprin[āa]t)/i,                        // lv
  /^\s*(akceptuj|zgadzam si[ęe]|zgoda)/i,                    // pl
  /^\s*(accept[ăa]|de acord)/i,                              // ro
  /^\s*(sprejmi|se strinjam)/i,                              // sl
  /* Hungarian was missing from both tiers entirely, and it is not an exotic
     case for this client: feedadditives.example showed "Elfogadom / Elutasítom", nothing
     matched, the log said "no consent dialog found", and the banner sat across
     the bottom of every screenshot of that company. Three of the eight test
     companies were Hungarian. The rest of this block closes the same hole for
     the other EU languages the list had never covered. */
  /^\s*(elfogadom|elfogad|[öo]sszes elfogad|rendben)/i,      // hu
  /^\s*(accepteren|alles accepteren|akkoord)/i,              // nl
  /^\s*(accept[eé]r|tillad alle)/i,                          // da
  /^\s*(acceptera|godk[äa]nn)/i,                             // sv
  /^\s*(hyv[äa]ksy|salli kaikki)/i,                          // fi
  /^\s*(n[õo]ustun|luba k[õo]ik)/i,                          // et
  /^\s*(sutinku|priimti|leisti visus)/i,                     // lt
  /^\s*(приемам|съгласен|приеми)/i,                          // bg
  /^\s*(prihva[ćc]am|prihvati)/i,                            // hr
];

/* Promotional modals / newsletter popups / lightboxes. These are NOT consent
   dialogs and no consent library manages them, so they need their own pass. */
const OVERLAY_CLOSE_SELECTORS = [
  '[role="dialog"] [aria-label*="close" i]',
  '[aria-modal="true"] [aria-label*="close" i]',
  'button[aria-label*="close" i]',
  'button[aria-label*="chiudi" i]',   // it
  'button[aria-label*="cerrar" i]',   // es
  'button[aria-label*="fermer" i]',   // fr
  'button[aria-label*="schlie" i]',   // de
  '[data-dismiss="modal"]', '[data-bs-dismiss="modal"]',
  '.modal .close', '.modal-close', '.popup-close', '.close-modal',
  '.mfp-close', '.fancybox-close', '.fancybox-close-small',
  // Scoped to buttons: as bare descendant selectors these matched ordinary
  // navigation links inside anything with "modal" in an ancestor class.
  '[class*="popup" i] button[class*="close" i]',
  '[class*="modal" i] button[class*="close" i]',
  // Chat / "AI assistant" widgets are not consent dialogs and rarely say
  // "close" — they say "minimize", or use an icon-only toggle button that
  // re-opens the panel. Target both, scoped to the widget so we don't grab
  // an unrelated close button elsewhere on the page.
  '[class*="chat" i] button[aria-label*="close" i]',
  '[class*="chat" i] button[aria-label*="minimize" i]',
  '[class*="assistant" i] button[aria-label*="close" i]',
  '[class*="assistant" i] button[aria-label*="minimize" i]',
  '[id*="chat" i] button[aria-label*="close" i]',
  '[id*="assistant" i] button[aria-label*="close" i]',
  // Common third-party chat-widget vendors ship predictable class/id hooks.
  '.intercom-launcher-close-icon',
  '.crisp-client [data-icon="close"]',
  '.woot-widget-bubble--close',
  '#launcher[aria-label*="close" i]', // Zendesk
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function capture(opts = {}) {
  const {
    url,
    width = 1440,
    height = 900,
    deviceScaleFactor: requestedDsf = 2,
    maxScrollRounds = 60,
    maxPageHeight = 60000,
    navTimeout = 60000,
    /* 'png' (lossless, the single-capture default) or 'jpeg'. Batch runs use
       jpeg: a few hundred full-page PNGs is a several-GB download, and at this
       quality the difference is invisible when reviewing page content. */
    format = 'png',
    quality = 82,
    /* Batch runs name their own files (companyfolder/homepage.jpg) rather than
       taking the host-and-timestamp default. */
    fileName = null,
    outDir = null,
    onLog = () => {},
  } = opts;

  const target = normaliseUrl(url);
  /* Mirrored to the server console so a run is followable from the terminal
     as well as the browser — but only when nobody supplied a log sink. A caller
     that passes onLog (the batch, the tests) is handling output itself, and
     duplicating it here doubles every line of a 181-company run. */
  const log = opts.onLog
    ? (msg) => onLog(msg)
    : (msg) => { onLog(msg); console.log('  ' + msg); };

  const destDir = outDir || SHOTS_DIR;
  await fs.mkdir(destDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--font-render-hinting=none',
      /* Docker caps /dev/shm at 64MB. Chromium puts rendering surfaces there, and
         a tall image-heavy page overruns it — the renderer is killed and Playwright
         reports the opaque "Target crashed". This routes that memory to /tmp
         instead, which is disk-backed and unbounded. Harmless locally. */
      '--disable-dev-shm-usage',
      // Headless has no GPU in a container; leaving it on wastes memory on an
      // acceleration path that immediately falls back to software anyway.
      '--disable-gpu',
      // Background tabs/timers are irrelevant here and consume renderer memory.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ],
  });

  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: requestedDsf,
    userAgent: UA,
    // Was hardcoded to sk-SK/Bratislava — a leftover from testing against
    // Slovak sites specifically. That meant every capture, regardless of
    // which country's site it was hitting, showed up as a Slovak browser —
    // not a fix for any confirmed block, but a real mismatch (an Italian or
    // French company site being visited by a "Slovak" browser) that some
    // bot-detection systems weigh alongside everything else. en-US is the
    // least distinctive default the web sees — but it is not free on a
    // multilingual site, which reads it and serves English. See captureLocale.
    locale: captureLocale(target),
    // Stops CSS/JS that branches on prefers-reduced-motion from animating at all.
    reducedMotion: 'reduce',
  });

  // Strip the most obvious automation tell before any page script runs.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(navTimeout);

  const started = Date.now();
  const steps = [];

  /* Hard ceiling on the whole capture. Individual steps have their own timeouts,
     but this guarantees a request always terminates — a hung capture holds a
     browser process and a connection open indefinitely otherwise. */
  const HARD_TIMEOUT_MS = Number(process.env.CAPTURE_TIMEOUT_MS || 8 * 60 * 1000);
  let timeoutHandle;
  const deadline = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`Capture exceeded ${Math.round(HARD_TIMEOUT_MS / 1000)}s and was aborted. The page is unusually large — try a narrower viewport or a specific article.`)),
      HARD_TIMEOUT_MS
    );
  });
  // If the pipeline finishes first, nothing awaits `deadline`; swallow its later
  // rejection so it cannot surface as an unhandled rejection and kill the process.
  deadline.catch(() => {});
  /* Surfacing >5s steps in the live log (not just the final `steps` summary) is
     what would have made the newssite.example stall obvious immediately instead of
     needing to read the source — the log said "no consent dialog found" with
     no hint that finding that answer took several minutes. */
  const SLOW_STEP_MS = 5000;
  const step = async (name, fn) => {
    const t = Date.now();
    let result;
    try {
      result = await fn();
      const ms = Date.now() - t;
      if (ms > SLOW_STEP_MS) log(`(${name} took ${(ms / 1000).toFixed(1)}s)`);
      steps.push({ name, ms, ok: true, detail: result ?? null });
    } catch (err) {
      steps.push({ name, ms: Date.now() - t, ok: false, detail: err.message });
      log(`${name} — skipped (${err.message.split('\n')[0]})`);
      return null;
    }
    return result;
  };

  const runPipeline = async () => {
    /* 1 ── Navigate. NOT wrapped in step(): every other stage is optional and may
       be skipped, but if the page will not load there is nothing to screenshot.
       Swallowing this produced blank PNGs reported as successful captures. */
    let httpStatus = null;
    {
      const t = Date.now();
      log(`navigating to ${target}`);
      let response;
      try {
        response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: navTimeout });
      } catch (err) {
        steps.push({ name: 'navigate', ms: Date.now() - t, ok: false, detail: err.message });
        throw new Error(`Could not load ${target} — ${describeNavError(err.message)}`);
      }
      httpStatus = response?.status() ?? null;
      const landed = page.url();
      if (landed.replace(/\/$/, '') !== target.replace(/\/$/, '')) {
        log(`redirected to ${landed}`);
      }
      /* A 4xx/5xx still renders an error page, which would otherwise be captured
         and returned as though it were the site. Fail with the status instead. */
      if (httpStatus && httpStatus >= 400) {
        steps.push({ name: 'navigate', ms: Date.now() - t, ok: false, detail: `HTTP ${httpStatus}` });
        throw new Error(
          `${target} returned HTTP ${httpStatus}` +
          (httpStatus === 403
            ? ' — the site is blocking automated browsers.'
            : httpStatus === 404
              ? ' — page not found.'
              : '.')
        );
      }
      steps.push({ name: 'navigate', ms: Date.now() - t, ok: true, detail: `HTTP ${httpStatus} ${landed}` });
    }

    /* 2 ── Bot-check interstitial (newssite.example sits behind Cloudflare). Wait it out. */
    await step('bot-check', async () => {
      const isChallenge = async () => {
        const t = await page.title().catch(() => '');
        return /just a moment|checking your browser|attention required|moment…/i.test(t);
      };
      if (!(await isChallenge())) return 'none';
      log('bot-check interstitial detected, waiting for it to clear');
      for (let i = 0; i < 40; i++) {
        await sleep(1000);
        if (!(await isChallenge())) { log('bot-check cleared'); return `cleared in ~${i + 1}s`; }
      }
      return 'still present after 40s';
    });

    /* 3 ── Consent / cookie wall, else it covers the shot. */
    await step('consent', async () => {
      const clicked = await dismissConsent(page);
      log(clicked ? `dismissed consent via ${clicked}` : 'no consent dialog found');
      if (clicked) await sleep(800);
      return clicked || 'none';
    });

    /* 3a ── Promotional modals and newsletter popups. Distinct from consent: no
       CMP library owns them, so they survive the consent pass and sit on top of
       the hero. Escape first (cheapest and works on most), then close buttons,
       then hide whatever modal-shaped thing is still covering the page. */
    await step('overlays', async () => {
      const n = await dismissOverlays(page);
      log(n ? `dismissed ${n} overlay/popup element(s)` : 'no blocking overlay found');
      if (n) await sleep(500);
      return n;
    });

    /* 3b ── CMPs are frequently injected a second or two after first paint, well
       after step 3 ran. Give it one more pass before we start scrolling. */
    await step('consent-retry', async () => {
      await sleep(2500);
      const clicked = await dismissConsent(page);
      if (clicked) { log(`dismissed late consent via ${clicked}`); await sleep(800); }
      return clicked || 'none';
    });

    /* 4 ── Bounded network settle. Never blocks forever on a polling socket. */
    await step('network-settle', async () => {
      try {
        await page.waitForLoadState('networkidle', { timeout: 12000 });
        return 'idle';
      } catch { return 'timeout (proceeding)'; }
    });

    /* 4b ── JS carousel/slider libraries (Swiper, Slick, Splide...) measure
       their container's width once, at init, and position slides with an
       inline transform computed from that number. If their init script runs
       before the surrounding CSS/layout has fully settled, they can lock in a
       wrong (sometimes zero) width and never re-measure — the DOM and images
       are all there, correctly loaded, but every slide sits transformed off
       to the side, rendering as a blank band (seen on slidersite.example's Swiper.js
       hero: 43/43 images loaded, nothing wrong found, yet the banner was
       empty). A `resize` event is the standard trigger these libraries listen
       for to recompute, so fire one now that layout should be stable. */
    await step('layout-recalc', async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('resize'))).catch(() => {});
      await sleep(300);
      return 'resize dispatched';
    });

    /* 5 ── Do NOT mass-promote lazy images here. Flipping every image to eager at
       once makes the browser decode 121 images simultaneously, which spikes
       renderer memory hard enough to be OOM-killed in a memory-capped container.
       Promotion now happens progressively inside the scroll pass instead: only
       images within ~2 viewports of the current position are unlazied, so peak
       memory stays bounded regardless of how many images the page has. */

    /* 6 ── Scroll passes until height stops growing. newssite.example grows ~2000px and
       doubles its image count on the first pass alone. Capped both ways. */
    const scrollInfo = await step('scroll-lazyload', async () => {
      const info = await autoScroll(page, { maxScrollRounds, maxPageHeight, log });
      log(`scrolled ${info.rounds} round(s), height ${info.startHeight} → ${info.endHeight}px, unlazied ${info.promoted} image(s) progressively${info.capped ? ' (CAPPED)' : ''}`);
      if (info.placeholders > 0) {
        log(`WARNING: ${info.placeholders} image(s) still look like lazy-load placeholders — this site likely uses a lazy-load convention pagesnap doesn't recognize yet, expect blank spots in the capture`);
      }
      return info;
    });

    /* 6b ── Scroll- and exit-intent-triggered popups only appear after the user
       has moved down the page, so the earlier passes cannot have seen them. */
    await step('overlays-post-scroll', async () => {
      const c = await dismissConsent(page);
      const n = await dismissOverlays(page);
      if (c || n) log(`cleared ${n} late overlay(s)${c ? ` and a late consent dialog` : ''}`);
      if (c || n) await sleep(400);
      return { consent: c || 'none', overlays: n };
    });

    /* 6c ── Open collapsed content. Runs after the scroll pass, so widgets
       below the fold exist and their scripts have initialised, and before the
       image wait, so anything revealed still gets loaded and counted. */
    const expandInfo = await step('expand-collapsed', async () => {
      const info = await expandCollapsed(page);
      if (info.expanded) {
        log(`opened ${info.expanded} collapsed section(s)${info.panels ? `, revealed ${info.panels} tab panel(s)` : ''}`);
        /* Revealed content brings its own lazy images and its own height, and
           neither was there when the scroll pass ran. One more round is enough:
           the sections are open now, nothing further is waiting on a click. */
        const re = await autoScroll(page, { maxScrollRounds: 1, maxPageHeight, log });
        log(`re-scrolled after expanding, height ${re.startHeight} → ${re.endHeight}px`);
      }
      if (info.carousels) {
        log(`WARNING: ${info.carousels} carousel(s) holding ${info.hiddenSlides} off-screen slide(s) — only the visible slide is in the capture`);
      }
      return info;
    });

    /* 7 ── Fonts, then images. Tolerant: third-party ad images frequently never
       resolve, so we wait for progress to stall rather than for perfection. */
    await step('fonts', async () => {
      await page.evaluate(() => document.fonts?.ready).catch(() => {});
      return 'ready';
    });

    const imgInfo = await step('images', async () => {
      const info = await waitForImages(page, { timeout: 20000 });
      log(`images ${info.loaded}/${info.total} loaded${info.pending ? `, ${info.pending} unresolved (likely ads)` : ''}`);
      return info;
    });

    /* 8 ── Freeze all motion. Must run AFTER scrolling, because scroll-triggered
       reveal animations need to have fired before we pin them to their end state. */
    await step('freeze-motion', async () => {
      await freezeMotion(page);
      log('animations, transitions and media frozen');
      return 'frozen';
    });

    /* 9 ── Back to top and let the compositor paint one clean frame. */
    await step('settle', async () => {
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(600);
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      return 'settled';
    });

    /* 9b ── overlaysite.example showed this happening: overlays-post-scroll clicked
       "Odrzuć wszystkie ciasteczka" and it visibly closed, but the widget's own
       script re-asserted it a couple of seconds later — after images/freeze-motion
       had already run and with nothing left in the pipeline to catch it before the
       shutter. This is the last possible moment to catch a dialog that reopened
       itself, so it runs right before capture rather than being folded into an
       earlier step. */
    await step('consent-final', async () => {
      const c = await dismissConsent(page);
      const n = await dismissOverlays(page);
      if (c || n) {
        log(`cleared ${n} overlay(s)${c ? ` and a re-appeared consent dialog` : ''} right before capture`);
        await sleep(400);
      }
      /* Every dismiss click above moves Playwright's real mouse pointer to sit
         on top of whatever it clicked. That pointer position sticks — browsers
         re-evaluate :hover against the last known cursor position on scroll,
         with no new mousemove needed — so after `settle` scrolls back to (0,0),
         some unrelated element can end up frozen mid-capture in its :hover
         style (seen on overlaysite.example: a service card rendered solid black
         instead of its normal red, sitting wherever the last click happened to
         land after the page scrolled). Parking the pointer off the page after
         all clicking is done, and before the freeze/settle-triggered capture,
         removes the stray hover regardless of which element it was on.
         Applies to every site, not just this one. */
      await page.mouse.move(-1, -1).catch(() => {});
      return { consent: c || 'none', overlays: n };
    });

    /* 10 ── Capture. */
    const file = fileName || buildFilename(target, format);
    const outPath = path.join(destDir, file);
    const dims = await page.evaluate(() => ({
      w: document.documentElement.scrollWidth,
      h: document.documentElement.scrollHeight,
    }));

    /* Capture by scrolling and stitching rather than Playwright's fullPage.
       fullPage rasterises the whole document in one surface and silently returns
       blank bands past ~16000px; slices are viewport-sized so the limit never
       applies and we keep the full retina scale factor. */
    /* Each slice is rasterised at scale^2 the pixels. On a very tall page that is
       the difference between finishing and being OOM-killed, so step down. */
    /* PAGESNAP_MAX_SCALE lets a memory-capped host force 1x, which quarters the
       pixels sharp has to composite. Tall pages step down regardless. */
    const scaleCap = Number(process.env.PAGESNAP_MAX_SCALE || requestedDsf);
    let safeScale = Math.min(requestedDsf, scaleCap, dims.h > 20000 ? 1 : requestedDsf);
    if (safeScale !== requestedDsf) {
      log(`page is ${dims.h}px tall — capturing at ${safeScale}x instead of ${requestedDsf}x to stay within memory`);
    }

    /* JPEG cannot store a dimension above 65535px — a hard format limit, not a
       memory one, and libjpeg simply throws. PNG has no such ceiling, which is
       why this never mattered until batch runs started emitting JPEG. Note
       maxPageHeight only stops infinite scroll from growing the page further;
       it does not shrink a page that is genuinely this tall, so dims.h can
       still land above the limit. Drop the scale first, and if even 1x doesn't
       fit, emit PNG instead — a slightly larger file beats a failed row with an
       error nobody can act on. */
    let outFormat = format;
    let outFile = file;
    let outFullPath = outPath;
    if (outFormat === 'jpeg') {
      const JPEG_MAX = 65500; // a little under 65535 for rounding headroom
      if (dims.h * safeScale > JPEG_MAX) {
        const fitted = Math.max(1, Math.floor(JPEG_MAX / dims.h));
        if (dims.h <= JPEG_MAX) {
          safeScale = Math.min(safeScale, fitted);
          log(`page is ${dims.h}px tall — capping at ${safeScale}x so the jpeg stays under ${JPEG_MAX}px`);
        } else {
          outFormat = 'png';
          outFile = file.replace(/\.jpe?g$/i, '.png');
          outFullPath = path.join(destDir, outFile);
          safeScale = 1;
          log(`page is ${dims.h}px tall — beyond jpeg's ${JPEG_MAX}px limit, saving as PNG instead`);
        }
      }
    }
    log(`capturing ${dims.h}px in ${Math.ceil(dims.h / height)} slice(s) at ${safeScale}x`);
    const stitched = await scrollAndStitch(page, {
      outPath: outFullPath,
      viewportHeight: height,
      scale: safeScale,
      format: outFormat,
      quality,
      onLog: () => {},
    });
    log(`stitched ${stitched.slices} slice(s) → ${stitched.width}x${stitched.height}px`);

    const { size } = await fs.stat(outFullPath);
    log(`saved ${outFile} (${(size / 1024 / 1024).toFixed(2)} MB)`);

    return {
      ok: true,
      url: target,
      // The actual name written — may differ from the requested one if a very
      // tall page had to fall back from jpeg to png, so callers that record a
      // path (the batch spreadsheet) must use this rather than assuming.
      file: outFile,
      path: outFullPath,
      format: outFormat,
      pageWidth: dims.w,
      pageHeight: dims.h,
      httpStatus,
      finalUrl: page.url(),
      scale: safeScale,
      capped: scrollInfo?.capped ?? false,
      images: imgInfo ?? null,
      /* Images that still look like lazy-load placeholders when we shot the
         page — i.e. probable blank rectangles in the finished screenshot. Only
         logged before this; the batch spreadsheet needs it too, because a
         reviewer looking at the XLSX has no other way to know a capture came
         out with holes in it. */
      placeholders: scrollInfo?.placeholders ?? 0,
      /* How much of the page was opened up before shooting, and how much could
         not be. A reviewer looking at a carousel that shows two logos out of
         twenty-five has no way to tell that from a broken capture; the count
         goes to the spreadsheet so the row can say which it was. */
      expanded: expandInfo?.expanded ?? 0,
      carousels: expandInfo?.carousels ?? 0,
      hiddenSlides: expandInfo?.hiddenSlides ?? 0,
      bytes: size,
      durationMs: Date.now() - started,
      steps,
    };
  };

  try {
    return await Promise.race([runPipeline(), deadline]);
  } catch (err) {
    /* "Target crashed" means the renderer process died — nearly always memory
       exhaustion on a very tall, image-heavy page. Say so, rather than surfacing
       Playwright's opaque wording. */
    if (/Target crashed|Target closed|browser has been closed/i.test(err.message)) {
      throw new Error(
        'The browser ran out of memory on this page. It is unusually tall or ' +
        'image-heavy. Try a narrower viewport, or capture a specific article ' +
        'rather than the homepage.'
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

/* ── helpers ─────────────────────────────────────────────────────── */

function normaliseUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) throw new Error('URL is required');
  const withProto = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  const u = new URL(withProto); // throws on genuinely malformed input
  return u.toString();
}

/* Which browser locale to present for a given URL.
 *
 * A multilingual site reads the browser's language and serves accordingly. With
 * the context pinned to en-US, a Hungarian site's own default URLs came back in
 * English while a URL that names its language in the path came back in that
 * language — so one company's three captures could arrive in two languages even
 * though the URLs handed to us were consistent. QA reproduced exactly that on a
 * .hu site: English homepage, English about-us, Hungarian product page.
 *
 * Deliberately narrow. An explicit language segment in the path is the site's
 * own statement of intent and always wins; failing that, a .hu host defaults to
 * Hungarian. Everything else keeps the previous en-US behaviour — this is not
 * the start of a country-TLD-to-locale table, and shouldn't become one without
 * evidence of the same failure elsewhere.
 */
export function captureLocale(url) {
  try {
    const parsed = new URL(url);
    // Path only, so ?lang=… and #fragments can never confuse the match.
    const pathname = parsed.pathname.toLowerCase();
    if (/^\/en(?:\/|$)/.test(pathname)) return 'en-US';
    if (/^\/hu(?:\/|$)/.test(pathname)) return 'hu-HU';

    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'hu' || hostname.endsWith('.hu')) return 'hu-HU';
  } catch {
    // Unparseable input keeps the old default rather than throwing here;
    // normaliseUrl is what reports a genuinely malformed URL.
  }
  return 'en-US';
}

function buildFilename(url, format = 'png') {
  const host = new URL(url).hostname.replace(/^www\./, '').replace(/[^a-z0-9.-]/gi, '-');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${host}-${ts}.${format === 'jpeg' ? 'jpg' : 'png'}`;
}

/* Scans a set of button-like elements ONCE, fetching each one's href/text with
   exactly two Playwright round-trips, then tests every CONSENT_TEXTS pattern
   against that already-fetched string in plain JS (no round-trip per pattern).
   Stops the instant a reject-tier match is found (it outranks accept), and
   otherwise remembers the first accept-tier match as a fallback.

   This replaces an earlier version that looped patterns on the OUTSIDE and
   buttons on the inside — i.e. it re-fetched innerText()/getAttribute() for
   every button, once per regex pattern (~27 patterns). On a button/link-heavy
   page that is O(patterns × buttons) real browser round-trips: on newssite.example,
   whose first consent check found nothing via the fast selector list and fell
   through to this scan, that combination is what actually produced the
   multi-minute stall before the pipeline ever started scrolling — not the
   Cloudflare check or page size, which is what it looked like from the log
   alone. This version is O(buttons) regardless of pattern count. */
async function findConsentMatch(scope, cap) {
  const buttons = scope.locator('button, a, [role="button"], [class*="btn" i]');
  const n = Math.min(await buttons.count().catch(() => 0), cap);
  let acceptMatch = null;
  for (let i = 0; i < n; i++) {
    const b = buttons.nth(i);
    const href = await b.getAttribute('href').catch(() => null);
    if (href && !/^#|^javascript:/i.test(href)) continue; // navigation, not consent
    const txt = (await b.innerText().catch(() => '')).trim();
    if (!txt) continue;
    if (CONSENT_TEXTS_REJECT.some((rx) => rx.test(txt))) {
      if (await b.isVisible().catch(() => false)) return { el: b, txt };
      continue; // matched but hidden — keep scanning, something else may match
    }
    if (!acceptMatch && CONSENT_TEXTS_ACCEPT.some((rx) => rx.test(txt))) {
      acceptMatch = { el: b, txt };
    }
  }
  if (acceptMatch && (await acceptMatch.el.isVisible().catch(() => false))) return acceptMatch;
  return null;
}

async function dismissConsent(page) {
  const startUrl = page.url();
  const restore = async () => {
    if (page.url() !== startUrl) {
      await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await sleep(1000);
    }
  };

  // Some CMPs (and custom-built consent widgets, e.g. the Cookiebot-style
  // accept/reject/save-settings banner on overlaysite.example) mount inside an
  // <iframe> rather than the top document. page.locator() on `page` alone
  // never sees into that iframe, so every pass below also checks each child
  // frame — same selectors, same text patterns, just a wider search scope.
  const frames = [page, ...page.frames().filter((f) => f !== page.mainFrame())];

  for (const sel of CONSENT_SELECTORS) {
    for (const scope of frames) {
      const el = scope.locator(sel).first();
      if (await el.count().then((c) => c > 0).catch(() => false)) {
        if (await el.isVisible().catch(() => false)) {
          await el.click({ timeout: 3000 }).catch(() => {});
          await restore();
          return sel;
        }
      }
    }
  }
  // Fall back #1: search inside likely cookie-banner containers first. Custom
  // banners with no known library selector (e.g. flowhunt.io's) are almost always
  // portal-mounted at the very end of <body>, so a whole-page button scan capped
  // at a fixed number can run out before ever reaching them on a busy page.
  // Scoping to the container directly sidesteps that DOM-position problem.
  const CONTAINER_SELECTOR =
    '[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], ' +
    '[id*="gdpr" i], [class*="gdpr" i], [id*="cmp" i], [class*="cmp" i], ' +
    '[aria-label*="cookie" i], [aria-label*="consent" i]';
  for (const scope of frames) {
    const containers = scope.locator(CONTAINER_SELECTOR);
    const containerCount = Math.min(await containers.count().catch(() => 0), 20);
    for (let ci = 0; ci < containerCount; ci++) {
      const container = containers.nth(ci);
      if (!(await container.isVisible().catch(() => false))) continue;
      const match = await findConsentMatch(container, 50);
      if (match) {
        await match.el.click({ timeout: 3000 }).catch(() => {});
        await restore();
        return `container:"${match.txt.slice(0, 30)}"`;
      }
    }
  }

  // Fall back #2: match visible button text across the whole page (handles Slovak
  // CMPs without stable ids). Cap raised from 200 to 400 as a wider safety net.
  for (const scope of frames) {
    const match = await findConsentMatch(scope, 400);
    if (match) {
      await match.el.click({ timeout: 3000 }).catch(() => {});
      await restore();
      return `text:"${match.txt.slice(0, 30)}"`;
    }
  }
  return null;
}

async function autoScroll(page, { maxScrollRounds, maxPageHeight, log }) {
  return page.evaluate(
    async ({ maxScrollRounds, maxPageHeight }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const H = () => document.documentElement.scrollHeight;
      const startHeight = H();
      let rounds = 0, stableFor = 0, capped = false, y = 0, promoted = 0;

      /* Unlazy only what is about to be on screen. Bounding this to a couple of
         viewports is what keeps peak decode memory flat instead of proportional
         to the number of images on the page.

         `data-src`/`data-srcset` covers the most common convention (lazysizes
         and most CMP-adjacent libraries), but it is not universal — e.g. a
         WordPress/Woodmart product page seen in testing served
         `<img src=".../lazy.svg">` with NO data-src/data-srcset at all, so
         there was nothing here for the original selector to grab. Widened to
         the handful of other attribute names real lazy-load libraries use for
         the same purpose (data-lazy-src, data-lazy, data-original are common
         in older jQuery-based loaders), plus a background-image variant for
         elements that reveal a photo via CSS rather than an <img> src at all.
         This does not claim to fix every convention — Woodmart's own mechanism
         still isn't confirmed; see placeholderCount below for why. */
      const LAZY_ATTRS = ['data-src', 'data-lazy-src', 'data-lazy', 'data-original'];
      const LAZY_SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset'];
      const LAZY_BG_ATTRS = ['data-bg', 'data-background', 'data-bg-url'];
      const lazySelector = [
        ...LAZY_ATTRS.map((a) => `img[${a}]`),
        ...LAZY_SRCSET_ATTRS.map((a) => `source[${a}]`),
        ...LAZY_BG_ATTRS.map((a) => `[${a}]`),
      ].join(', ');
      const promoteNearby = () => {
        const vh = window.innerHeight;
        for (const el of document.querySelectorAll(lazySelector)) {
          const host = el.tagName === 'SOURCE' ? el.parentElement : el;
          const r = host?.getBoundingClientRect();
          if (!r || r.top > vh * 2 || r.bottom < -vh) continue;
          for (const a of LAZY_ATTRS) {
            const v = el.getAttribute(a);
            if (v && !el.getAttribute('src')) { el.setAttribute('src', v); promoted++; }
          }
          for (const a of LAZY_SRCSET_ATTRS) {
            const v = el.getAttribute(a);
            if (v && !el.getAttribute('srcset')) { el.setAttribute('srcset', v); promoted++; }
          }
          for (const a of LAZY_BG_ATTRS) {
            const v = el.getAttribute(a);
            if (v && !el.style.backgroundImage) { el.style.backgroundImage = `url(${v})`; promoted++; }
          }
          for (const a of [...LAZY_ATTRS, ...LAZY_SRCSET_ATTRS, ...LAZY_BG_ATTRS]) el.removeAttribute(a);
        }
      };

      /* Diagnostic only, not a fix: count <img> tags whose src still looks like
         a lazy-load placeholder (a "lazy"/"placeholder"/"blank" filename, or a
         tiny inline data: URI) after the unlazy pass above ran. This is what
         would have made the lazyimages.example bug (blank product photos)
         visible in the log immediately — "images 141/144 loaded" alone doesn't
         distinguish "a few slow ad images" from "a lazy-loader we don't
         understand," but a nonzero placeholder count does. */
      const countPlaceholders = () => {
        let n = 0;
        for (const img of document.images) {
          const src = img.currentSrc || img.src || '';
          if (/lazy(\.|-)|placeholder|blank\.(gif|png|svg)|1x1\.(gif|png)/i.test(src)) n++;
          else if (/^data:image\/[a-z+]+;base64,/.test(src) && src.length < 400) n++; // tiny inline stand-in
        }
        return n;
      };

      while (rounds < maxScrollRounds) {
        rounds++;
        const before = H();

        for (y = 0; y <= H(); y += Math.round(window.innerHeight * 0.8)) {
          window.scrollTo(0, y);
          promoteNearby();
          await sleep(150); // give IntersectionObservers time to fire
          if (H() > maxPageHeight) { capped = true; break; }
        }
        window.scrollTo(0, H());
        promoteNearby();
        await sleep(900);

        if (capped) break;
        if (H() === before) { if (++stableFor >= 2) break; } else stableFor = 0;
      }
      window.scrollTo(0, 0);
      return { rounds, startHeight, endHeight: H(), capped, promoted, placeholders: countPlaceholders() };
    },
    { maxScrollRounds, maxPageHeight }
  );
}

/* Accordions and tabs are captured in whatever state they load in, which is
   "closed". biomed.example's About page came back with Mission, Collaborative
   Research, the Lab section and The team collapsed to four one-line headings,
   and feedadditives.example's Products page showed one of its three tabs — in both cases
   the content a reviewer wanted was in the DOM, just not on screen. Open what
   can be opened safely; count what cannot.

   Deliberately narrow. Blanket-unhiding everything with display:none reveals
   modals, cookie dialogs and mobile menus stacked over the page, which is a
   worse capture than the collapsed one. */
async function expandCollapsed(page, { budgetMs = 6000, maxClicks = 60 } = {}) {
  return page.evaluate(
    async ({ budgetMs, maxClicks }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const deadline = Date.now() + budgetMs;
      let expanded = 0, clicks = 0;

      /* Never touch site navigation. Opening every header dropdown drops a
         wall of menu items over the top of the page and reveals nothing a
         reviewer is looking for. */
      const inChrome = (el) =>
        !!el.closest('nav, header, footer, [role="navigation"], [role="banner"], .menu, .navbar, .nav-menu');

      /* Clicking is what the page itself expects, so prefer it — but only
         where a click cannot navigate away or throw a modal over the shot. */
      const safeToClick = (el) => {
        if (inChrome(el)) return false;
        if (el.closest('[data-toggle="modal"], [data-bs-toggle="modal"], [data-fancybox]')) return false;
        const a = el.closest('a[href]');
        if (a) {
          const href = a.getAttribute('href') || '';
          // Same-page anchors and javascript: hooks are fine; real links are not.
          if (href && !href.startsWith('#') && !href.startsWith('javascript:')) return false;
        }
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };

      // 1. <details> opens without a click at all.
      for (const d of document.querySelectorAll('details:not([open])')) { d.open = true; expanded++; }

      /* 2. The ARIA disclosure pattern, plus the class conventions of the page
         builders these sites actually run on: Divi (feedadditives.example),
         Avada/Fusion (biomed.example), Elementor and Bootstrap. */
      const TOGGLES = [
        '[aria-expanded="false"]',
        '.et_pb_toggle:not(.et_pb_toggle_open) .et_pb_toggle_title',
        '.fusion-panel .panel-title a.collapsed',
        '.elementor-tab-title:not(.elementor-active)',
        '.accordion-button.collapsed',
        '.accordion-title:not(.active)',
      ].join(', ');
      for (const el of document.querySelectorAll(TOGGLES)) {
        if (Date.now() > deadline || clicks >= maxClicks) break;
        if (!safeToClick(el)) continue;
        try { el.click(); clicks++; expanded++; } catch { /* inert element */ }
        await sleep(40);
      }

      /* 3. Tabs are not accordions. Clicking each tab in turn shows one panel
         and hides the one before it, so the reviewer still ends up with a
         single panel — the last one, which is worse than the default. Reveal
         the panels directly instead, matched by role or by the builders'
         panel classes so this cannot unhide a dialog or a mobile menu. */
      let panels = 0;
      for (const p of document.querySelectorAll(
        '[role="tabpanel"], .et_pb_tab, .fusion-tab-content, .tab-pane, .elementor-tab-content'
      )) {
        const cs = getComputedStyle(p);
        const hidden = p.hasAttribute('hidden') || p.getAttribute('aria-hidden') === 'true'
          || cs.display === 'none' || cs.visibility === 'hidden';
        if (!hidden) continue;
        p.removeAttribute('hidden');
        p.setAttribute('aria-hidden', 'false');
        p.style.setProperty('display', 'block', 'important');
        p.style.setProperty('visibility', 'visible', 'important');
        p.style.setProperty('opacity', '1', 'important');
        p.style.setProperty('height', 'auto', 'important');
        panels++;
      }
      expanded += panels;

      /* 4. Carousels are NOT unrolled. A slider positions its slides with
         inline transforms its own script owns and re-applies; forcing them
         visible reliably breaks the page layout rather than fixing it. Count
         them instead, so the run can say honestly that one slide of N was
         captured — spacetech.example's partner strip showed two logos of about
         twenty-five and nothing in the output explained why. */
      let carousels = 0, hiddenSlides = 0;
      for (const track of document.querySelectorAll(
        '.swiper-wrapper, .slick-track, .splide__list, .owl-stage, .et_pb_slides, .fusion-carousel-holder, [data-carousel]'
      )) {
        const slides = [...track.children];
        if (slides.length < 2) continue;
        const box = track.getBoundingClientRect();
        const offscreen = slides.filter((s) => {
          const r = s.getBoundingClientRect();
          return r.width === 0 || r.right <= box.left + 1 || r.left >= box.right - 1;
        }).length;
        if (offscreen > 0) { carousels++; hiddenSlides += offscreen; }
      }

      return { expanded, panels, clicks, carousels, hiddenSlides };
    },
    { budgetMs, maxClicks }
  );
}

async function waitForImages(page, { timeout }) {
  return page.evaluate(async (timeout) => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const done = () => [...document.images].filter((i) => i.complete && i.naturalHeight > 0).length;
    const deadline = Date.now() + timeout;
    let lastCount = -1, stalledFor = 0;

    while (Date.now() < deadline) {
      const c = done();
      if (c === document.images.length) break;
      // If nothing new resolved across ~2.4s, the stragglers are never coming.
      if (c === lastCount) { if (++stalledFor >= 8) break; } else { stalledFor = 0; lastCount = c; }
      await sleep(300);
    }
    /* Force-decode what arrived so nothing paints mid-decode — but bounded.
       decode() can never settle on a memory-pressured page, and with hundreds of
       images that turns into an indefinite hang with no log output. */
    await Promise.race([
      Promise.allSettled([...document.images].map((i) => i.decode?.().catch(() => {}))),
      sleep(8000),
    ]);
    const loaded = done();
    return { total: document.images.length, loaded, pending: document.images.length - loaded };
  }, timeout);
}

async function freezeMotion(page) {
  /* Freezing is deceptively easy to get wrong. Forcing `animation-duration: 0s`
     makes every animation complete instantly, and an animation whose fill-mode is
     `none` then REVERTS to its base style — which for fade-in content is
     opacity: 0. That silently blanks whole sections of the capture. So: hold
     animations at their END state (fill-mode forwards) rather than cancelling
     them, and let Playwright's own `animations: 'disabled'` handle the rest. */
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 1ms !important;
        animation-delay: 0s !important;
        animation-iteration-count: 1 !important;
        animation-fill-mode: forwards !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        caret-color: transparent !important;
      }
      html { scroll-behavior: auto !important; }
      /* Pin common scroll-reveal patterns to their visible end state. */
      [data-aos], .aos-init, .animate, .fade-in, .reveal {
        opacity: 1 !important;
        transform: none !important;
        visibility: visible !important;
      }
    `,
  }).catch(() => {});

  await page.evaluate(() => {
    document.querySelectorAll('video').forEach((v) => { try { v.pause(); } catch {} });
    document.querySelectorAll('marquee').forEach((m) => { try { m.stop(); } catch {} });
    // Hold each running animation at its end state instead of cancelling it,
    // which would drop fill-mode:none animations back to their hidden base style.
    document.getAnimations?.().forEach((a) => {
      try {
        a.effect?.updateTiming?.({ fill: 'forwards' });
        a.finish();
      } catch { /* infinite animations cannot finish; pausing is enough */
        try { a.pause(); } catch {}
      }
    });
  }).catch(() => {});
}


/* Closes promotional modals, newsletter popups and lightboxes.
   Order matters: Escape and real close buttons let the site tear the modal down
   properly (including its backdrop and any scroll lock). Force-hiding is the last
   resort, and is deliberately narrow — it only targets elements that both look
   modal (role/aria/class) and actually cover a meaningful part of the viewport,
   so a legitimate full-bleed hero is never removed. */
async function dismissOverlays(page) {
  let closed = 0;
  /* Clicking blindly can navigate away — a mis-matched "close" control that is
     really a nav link leaves us screenshotting a different page entirely, which
     looks like success. Record where we started and return if we drift. */
  const before = page.url();

  await page.keyboard.press('Escape').catch(() => {});
  await sleep(250);

  /* Chat / "AI assistant" widgets are frequently third-party embeds that render
     their whole UI inside an <iframe> (Intercom, Crisp, Tawk.to, Chatwoot,
     Zendesk...). page.locator() on `page` only ever searches the top document,
     so a close button living inside that iframe is invisible to the pass below
     unless we also search each child frame. */
  const frames = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];

  for (const sel of OVERLAY_CLOSE_SELECTORS) {
    for (const frame of frames) {
      const els = frame.locator(sel);
      const n = Math.min(await els.count().catch(() => 0), 5);
      for (let i = 0; i < n; i++) {
        const el = els.nth(i);
        if (!(await el.isVisible().catch(() => false))) continue;
        // An <a> with a real href is a navigation link, not a close control.
        const href = await el.getAttribute('href').catch(() => null);
        if (href && !/^#|^javascript:/i.test(href)) continue;
        await el.click({ timeout: 1500 }).catch(() => {});
        closed++;
      }
    }
  }
  if (closed) await sleep(400);

  closed += await page.evaluate(() => {
    const vw = window.innerWidth, vh = window.innerHeight;
    const MODALISH = /modal|popup|pop-up|lightbox|overlay|dialog|interstitial|newsletter|promo/i;
    // Chat/help widgets ("AI assistant" bubbles, live-chat panels) are UI
    // chrome, not page content — persistent but deliberately small, usually
    // pinned to a corner. They fail the >12% coverage test below by design,
    // so they need their own, size-independent check.
    const CHATISH = /chat[-_]?widget|chatbot|chat-bubble|live-?chat|assistant|messenger|ai-widget/i;
    let hidden = 0;

    for (const el of document.querySelectorAll('body *')) {
      const s = getComputedStyle(el);
      if (s.position !== 'fixed' && s.position !== 'absolute') continue;
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) continue;

      const z = parseInt(s.zIndex, 10) || 0;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const coverage = (r.width * r.height) / (vw * vh);

      const cls = el.className || '', id = el.id || '';
      const looksModal =
        el.getAttribute('role') === 'dialog' ||
        el.getAttribute('aria-modal') === 'true' ||
        MODALISH.test(cls) ||
        MODALISH.test(id);
      const looksChat = CHATISH.test(cls) || CHATISH.test(id);

      const onScreen = r.top < vh && r.bottom > 0 && r.left < vw && r.right > 0;
      // Full-page overlays: must look modal AND float above the page AND
      // actually obscure a meaningful chunk of it.
      const isBlockingModal = looksModal && z >= 50 && coverage > 0.12 && onScreen;
      // Chat widgets: no size requirement — a 40x40 launcher counts just as
      // much as an open panel, since either one can sit in the final shot.
      const isChatWidget = looksChat && z >= 50 && onScreen;

      if (isBlockingModal || isChatWidget) {
        el.style.setProperty('display', 'none', 'important');
        hidden++;
      }
    }

    // Modals commonly lock scrolling; releasing it matters for the scroll pass.
    for (const el of [document.documentElement, document.body]) {
      el.style.setProperty('overflow', 'auto', 'important');
      el.style.setProperty('position', 'static', 'important');
    }
    return hidden;
  }).catch(() => 0);

  if (page.url() !== before) {
    await page.goto(before, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await sleep(1200);
  }
  return closed;
}

/* Turns Chromium's network error codes into something a user can act on. */
function describeNavError(msg) {
  if (/ERR_CONNECTION_REFUSED/.test(msg)) return 'the server refused the connection (the site may be offline or moved).';
  if (/ERR_NAME_NOT_RESOLVED/.test(msg)) return 'the domain does not resolve (check the address).';
  if (/ERR_CONNECTION_TIMED_OUT|Timeout/i.test(msg)) return 'the server did not respond in time.';
  if (/ERR_CERT|SSL/i.test(msg)) return 'the site has an invalid HTTPS certificate.';
  if (/ERR_CONNECTION_CLOSED|ERR_EMPTY_RESPONSE/.test(msg)) return 'the server closed the connection without responding.';
  return msg.split('\n')[0].slice(0, 120);
}
