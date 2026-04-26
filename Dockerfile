# syntax=docker/dockerfile:1

# ── Stage 1: build the React client ──────────────────────────────────────────
FROM --platform=linux/amd64 oven/bun:1.3-alpine AS web
WORKDIR /repo/app

COPY app/package.json app/bun.lock ./
RUN bun install --frozen-lockfile

COPY app/ ./
RUN bun run build
# Vite outDir is ../public → artifacts land at /repo/public/

# ── Stage 2: relay server runtime ────────────────────────────────────────────
FROM --platform=linux/amd64 oven/bun:1.3-alpine AS runtime
WORKDIR /repo

# We connect to a remote Chrome via CDP — never need puppeteer's bundled one.
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Self-signed TLS so the HTTPS server can boot. Mount real certs as a volume
# in compose.yml to override.
RUN apk add --no-cache openssl \
 && openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
        -days 365 -nodes -subj '/CN=localhost' 2>/dev/null

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./
COPY --from=web /repo/public ./public

EXPOSE 3050 3051
CMD ["bun", "src/index.ts"]
