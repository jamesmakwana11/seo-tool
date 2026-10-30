# DeoDap SEO Sentinel — single production service: the Express API also serves the built web app (same origin, HTTPS
# terminated by the hosting platform), runs the Go crawler + Rust text core as child processes, and (optionally)
# Lighthouse in a separate process.
#
#   docker build -t sentinel .                                   # crawler + text core, no browser (~512 MB RAM plans)
#   docker build --build-arg INSTALL_CHROMIUM=true -t sentinel . # + Chromium for Lighthouse / rendered checks (needs ≥1 GB RAM)
#
# Run: see DEPLOYMENT.md for the environment variables.

# ---------------------------------------------------------------- Go crawler (static binary)
FROM golang:1.24-bookworm AS go
WORKDIR /src
COPY services/crawler-go/go.mod services/crawler-go/go.sum ./
RUN go mod download
COPY services/crawler-go/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/sentinel-crawler . && /out/sentinel-crawler --version

# ---------------------------------------------------------------- Rust text core
FROM rust:1.88-slim-bookworm AS rust
WORKDIR /src
COPY services/textcore-rs/Cargo.toml services/textcore-rs/Cargo.lock ./
COPY services/textcore-rs/src ./src
COPY services/textcore-rs/tests ./tests
RUN cargo build --release --locked && install -D target/release/sentinel-textcore /out/sentinel-textcore && /out/sentinel-textcore --version

# ---------------------------------------------------------------- web + API bundle
FROM node:20-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY . .
# Builds the web bundle (served by the API) and the API server.
RUN npm run build:prod

# ---------------------------------------------------------------- runtime
FROM node:20-bookworm-slim AS runtime
ARG INSTALL_CHROMIUM=false
WORKDIR /app
# Chromium only when asked for: a browser needs 250–400 MB per run, more than a 512 MB plan can spare next to a crawl.
# ca-certificates: the Go crawler verifies HTTPS with the system trust store (node:*-slim ships without one — Node.js
# carries its own, Go does not). The crawler also has Mozilla's roots built in as a fallback.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && if [ "$INSTALL_CHROMIUM" = "true" ]; then apt-get install -y --no-install-recommends chromium fonts-liberation; fi \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_DIST_DIR=/app/apps/web/dist \
    CRAWLER_GO_BIN=/app/bin/sentinel-crawler \
    TEXTCORE_BIN=/app/bin/sentinel-textcore \
    CRAWLER_WORK_DIR=/tmp/sentinel-crawls \
    PUPPETEER_SKIP_DOWNLOAD=1 \
    # Node heap for a ~512 MB service (Render Starter): the crawler and text core run in their own processes, and the
    # crawl memory budget (85 % of the container limit) covers Node + Go + Rust together. Raise with the plan size.
    NODE_OPTIONS=--max-old-space-size=288
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# Only the API's runtime dependencies; @sentinel/shared is bundled into dist. Lighthouse is an optional dependency
# (installed, but only used when a browser is present).
RUN npm ci --omit=dev --no-audit --no-fund --workspace @sentinel/api --include-workspace-root=false && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/runtime apps/api/runtime
COPY --from=build /app/apps/web/dist apps/web/dist
COPY --from=go /out/sentinel-crawler bin/sentinel-crawler
COPY --from=rust /out/sentinel-textcore bin/sentinel-textcore
RUN mkdir -p /tmp/sentinel-crawls && chown node:node /tmp/sentinel-crawls
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/server.js"]
