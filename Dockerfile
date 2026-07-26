FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build:cloudflare

FROM node:22-alpine

WORKDIR /app
ENV PORT=80
ENV STATIC_ROOT=/app/public
ENV DATA_DIR=/data

COPY --from=builder /app/.open-next/assets/ /app/public/
COPY server/ /app/server/

VOLUME ["/data"]
EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1/api/health >/dev/null || exit 1

CMD ["node", "server/server.mjs"]
