#!/bin/sh
set -eu

jitsi_url=${JITSI_URL:-}
escaped_url=$(printf '%s' "$jitsi_url" | sed 's/\\/\\\\/g; s/"/\\"/g')

printf 'window.__NINJITSI_CONFIG__ = { jitsiUrl: "%s" };\n' "$escaped_url" \
  > /usr/share/nginx/html/runtime-config.js
