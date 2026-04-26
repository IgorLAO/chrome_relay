# syntax=docker/dockerfile:1

# ── Stage 1: build the React client ──────────────────────────────────────────
FROM oven/bun:1.3-alpine AS web
WORKDIR /repo/app

COPY app/package.json app/bun.lock ./
RUN bun install --frozen-lockfile

COPY app/ ./
RUN bun run build
# Vite outDir is ../public → artifacts land at /repo/public/

# ── Stage 2: relay server runtime (with embedded Chromium) ───────────────────
FROM oven/bun:1.3-alpine AS runtime
WORKDIR /repo

# Tell puppeteer to skip downloading its bundled chromium — we use the system one.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    CHROMIUM_PATH=/usr/bin/chromium-browser

# Chromium + minimal font/cert deps + openssl for the self-signed cert + tini
# as PID 1 so chromium child processes get reaped cleanly.
RUN apk add --no-cache \
        chromium \
        nss \
        freetype \
        harfbuzz \
        ca-certificates \
        ttf-freefont \
        openssl \
        tini \
 && openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
        -days 365 -nodes -subj '/CN=localhost' 2>/dev/null

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./
COPY --from=web /repo/public ./public

EXPOSE 3050 3051
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["bun", "src/index.ts"]
