FROM node:22-alpine AS deps

WORKDIR /app

RUN apk add --no-cache python3 make g++ \
    && corepack disable

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

FROM node:22-alpine AS runtime

RUN apk add --no-cache tini wget ca-certificates \
    && adduser -D -u 10001 mailcowrest

WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    CACHE_PATH=/data/auth-cache.db

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY bin ./bin
COPY src ./src

RUN mkdir -p /data \
    && chown -R mailcowrest:mailcowrest /app /data

USER mailcowrest
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1:${PORT}/health || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/server.js"]
