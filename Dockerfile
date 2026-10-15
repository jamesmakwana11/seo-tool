# DeoDap SEO Sentinel — single production service: the Express API also serves the built web app (same origin, HTTPS
# terminated by the hosting platform). Build:  docker build -t sentinel .   Run: see DEPLOYMENT.md for required env vars.

# ---------------------------------------------------------------- build
FROM node:20-bookworm-slim AS build
WORKDIR /app
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY . .
# The web bundle MUST talk to the real API: VITE_API_MODE=http (the default "mock" mode is the in-browser DEMO adapter).
RUN npm run build:prod

# ---------------------------------------------------------------- runtime
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    WEB_DIST_DIR=/app/apps/web/dist
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
# Only the API's runtime dependencies (express, pino, cheerio, nodemailer, zod); @sentinel/shared is bundled into dist.
RUN npm ci --omit=dev --no-audit --no-fund --workspace @sentinel/api --include-workspace-root=false && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/web/dist apps/web/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/server.js"]
