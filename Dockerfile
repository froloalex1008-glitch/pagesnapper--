# node:*-slim rather than the official Playwright image: the Playwright image is
# tagged per-release, so it breaks whenever the dependency is bumped. Installing
# the browser here with --with-deps pulls the same system libraries and tracks
# whatever version package.json actually resolves to.
FROM node:22-bookworm-slim

WORKDIR /app

# Copy manifests first. Docker caches this layer, so the slow install only re-runs
# when dependencies actually change — not on every edit to capture.js.
COPY package*.json ./

# --omit=dev keeps the image lean; there are no dev dependencies today, but this
# stops one being accidentally shipped later.
RUN npm ci --omit=dev

# Downloads Chromium AND the system libraries it needs (fonts, X11 libs, etc).
# Without --with-deps the binary is present but fails to launch with a shared
# library error that is genuinely painful to diagnose.
RUN npx playwright install --with-deps chromium

COPY . .

# Screenshots AND batch exports are written under /app/data. Mount a Railway
# volume at that one path to keep both across deploys — without one, every
# redeploy starts empty and a half-finished batch cannot be resumed.
RUN mkdir -p /app/data/screenshots /app/data/batches
ENV SCREENSHOT_DIR=/app/data/screenshots
ENV BATCH_DIR=/app/data/batches

# A stitched 2x capture of a long page can need several GB of RAM to composite.
# 1x is the difference between finishing and being OOM-killed on a small
# container; override to 2 on a plan with 8GB+ if the retina detail matters.
ENV PAGESNAP_MAX_SCALE=1

# Railway injects PORT at runtime; this is only the local default.
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
