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

detect_jvb_advertise_ips() {
  if [ -n "${NINJITSI_JVB_ADVERTISE_IPS:-}" ]; then
    printf '%s' "$NINJITSI_JVB_ADVERTISE_IPS"
    return
  fi

  detected_ip=$(
    ip route get 1.1.1.1 2>/dev/null |
      awk '{
        for (index = 1; index <= NF; index += 1) {
          if ($index == "src") {
            print $(index + 1)
            exit
          }
        }
      }'
  )

  if [ -z "$detected_ip" ]; then
    echo "Не найден активный IPv4-адрес. Задайте NINJITSI_JVB_ADVERTISE_IPS вручную." >&2
    detected_ip=127.0.0.1
  fi

  printf '%s' "$detected_ip"
}

prepare_jitsi() {
  mkdir -p "$local_root"
  jvb_advertise_ips=$(detect_jvb_advertise_ips)
  docker_host_address=${jvb_advertise_ips%%,*}
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
JVB_ADVERTISE_IPS=$jvb_advertise_ips
DOCKER_HOST_ADDRESS=$docker_host_address
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

  if grep -q '^PUBLIC_URL=http://localhost:8000$' "$jitsi_root/.env"; then
    sed -i.bak \
      's|^PUBLIC_URL=http://localhost:8000$|PUBLIC_URL=https://localhost:8443|' \
      "$jitsi_root/.env"
    rm -f "$jitsi_root/.env.bak"
  fi

  sed -i.bak \
    -e "s|^JVB_ADVERTISE_IPS=.*$|JVB_ADVERTISE_IPS=$jvb_advertise_ips|" \
    -e "s|^DOCKER_HOST_ADDRESS=.*$|DOCKER_HOST_ADDRESS=$docker_host_address|" \
    "$jitsi_root/.env"
  rm -f "$jitsi_root/.env.bak"

  echo "Jitsi подготовлен в $jitsi_root (media address: $jvb_advertise_ips)"
}

set_local_jitsi_browser_config() {
  config_file="$jitsi_root/config/web/config.js"
  attempt=0

  while [ "$attempt" -lt 15 ]; do
    if [ -f "$config_file" ] && grep -q 'config\.bosh' "$config_file"; then
      sed -i.bak \
        -e "s|^config\\.bosh = .*$|config.bosh = 'http://localhost:8000/http-bind';|" \
        -e "s|^config\\.websocket = .*$|config.websocket = 'ws://localhost:8000/xmpp-websocket';|" \
        "$config_file"
      rm -f "$config_file.bak"
      echo "Jitsi browser signaling uses local HTTP endpoints."
      return
    fi

    attempt=$((attempt + 1))
    sleep 2
  done

  echo "Jitsi config.js was not generated within 30 seconds." >&2
  exit 1
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
  set_local_jitsi_browser_config
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
  printf 'Jitsi:    http://localhost:8000\n'
fi
