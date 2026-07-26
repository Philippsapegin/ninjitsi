FROM node:22-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build:cloudflare

FROM nginx:1.29-alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/.open-next/assets/ /usr/share/nginx/html/
COPY --chmod=755 deploy/40-runtime-config.sh /docker-entrypoint.d/40-runtime-config.sh

EXPOSE 80
