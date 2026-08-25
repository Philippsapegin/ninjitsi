FROM node:22.23.2-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build:cloudflare

FROM node:22.23.2-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV STATIC_ROOT=/app/public
ENV DATA_DIR=/data

RUN mkdir -p /data && chown node:node /data

COPY --chown=node:node --from=builder /app/.open-next/assets/ /app/public/
COPY --chown=node:node server/ /app/server/

VOLUME ["/data"]
EXPOSE 8080

USER node

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health >/dev/null || exit 1

CMD ["node", "server/server.mjs"]
