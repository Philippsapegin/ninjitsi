#!/usr/bin/env sh
set -eu

action=${1:-up}
jitsi_version=stable-11031
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
project_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
local_root="$project_root/.local"
jitsi_root="$local_root/jitsi"
release_marker="$jitsi_root/.ninjitsi-release"
release_url="https://github.com/jitsi/docker-jitsi-meet/archive/refs/tags/$jitsi_version.zip"

secret() {
  od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
}

prepare_jitsi() {
  mkdir -p "$local_root"
  prepared_version=""

  if [ -f "$release_marker" ]; then
    prepared_version=$(cat "$release_marker")
  fi

  if [ "$prepared_version" != "$jitsi_version" ]; then
    if [ -d "$jitsi_root" ]; then
      mv "$jitsi_root" "$local_root/jitsi-backup-$(date +%Y%m%d-%H%M%S)"
    fi

    temp_root=$(mktemp -d)
    trap 'rm -rf "$temp_root"' EXIT HUP INT TERM
    curl -fL "$release_url" -o "$temp_root/jitsi.zip"
    unzip -q "$temp_root/jitsi.zip" -d "$temp_root/extract"
    extracted_root=$(find "$temp_root/extract" -mindepth 1 -maxdepth 1 -type d | head -n 1)

    if [ -z "$extracted_root" ]; then
      echo "Архив Jitsi не содержит ожидаемого каталога." >&2
      exit 1
    fi

    mv "$extracted_root" "$jitsi_root"
    printf '%s' "$jitsi_version" > "$release_marker"
    rm -rf "$temp_root"
    trap - EXIT HUP INT TERM
  fi

  if [ ! -f "$jitsi_root/.env" ]; then
    cp "$jitsi_root/env.example" "$jitsi_root/.env"
    cat >> "$jitsi_root/.env" <<EOF

# Ninjitsi local defaults
CONFIG=./config
HTTP_PORT=8000
HTTPS_PORT=8443
TZ=Etc/UTC
PUBLIC_URL=https://localhost:8443
JVB_ADVERTISE_IPS=127.0.0.1
DOCKER_HOST_ADDRESS=127.0.0.1
ENABLE_AUTH=0
ENABLE_GUESTS=1
ENABLE_LETSENCRYPT=0
ENABLE_HTTP_REDIRECT=0
ENABLE_PREJOIN_PAGE=0
ENABLE_WELCOME_PAGE=0
JICOFO_AUTH_PASSWORD=$(secret)
JVB_AUTH_PASSWORD=$(secret)
JIGASI_XMPP_PASSWORD=$(secret)
JIBRI_RECORDER_PASSWORD=$(secret)
JIBRI_XMPP_PASSWORD=$(secret)
EOF
  fi

  echo "Jitsi подготовлен в $jitsi_root"
}

case "$action" in
  prepare)
    prepare_jitsi
    exit 0
    ;;
  up|down|status|logs)
    ;;
  *)
    echo "Использование: ./scripts/stack.sh [prepare|up|down|status|logs]" >&2
    exit 2
    ;;
esac

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker не найден." >&2
  exit 1
fi

prepare_jitsi

if [ "$action" = "up" ]; then
  (cd "$jitsi_root" && docker compose up -d)
  (cd "$project_root" && docker compose up -d --build)
elif [ "$action" = "down" ]; then
  (cd "$jitsi_root" && docker compose down)
  (cd "$project_root" && docker compose down)
elif [ "$action" = "status" ]; then
  (cd "$jitsi_root" && docker compose ps)
  (cd "$project_root" && docker compose ps)
else
  (cd "$jitsi_root" && docker compose logs --tail 100)
  (cd "$project_root" && docker compose logs --tail 100)
fi

if [ "$action" = "up" ]; then
  printf '\nNinjitsi: http://localhost:3000\n'
  printf 'Jitsi:    https://localhost:8443\n'
  printf 'Grid Lab: http://localhost:3000/room/grid-lab\n'
fi
