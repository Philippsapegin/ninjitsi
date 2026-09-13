# Ninjitsi

Ninjitsi is a desktop-first web client for a self-hosted Jitsi deployment. It replaces the standard meeting interface with a responsive 16:9 grid, stage mode, local profiles, chat, device controls, and per-participant audio controls. Guests open a room link in a current desktop browser; they do not install Ninjitsi or Jitsi.

## Requirements

For a small public installation:

- Ubuntu 24.04 LTS or another 64-bit Linux distribution supported by Docker;
- at least 2 CPU cores, 4 GB RAM, and 20 GB free disk;
- root or `sudo` access;
- Docker Engine with Docker Compose v2, Git, curl, unzip, and OpenSSL;
- two DNS names pointing to the server, for example `call.example.com` and `jitsi.example.com`;
- inbound `80/tcp`, `443/tcp`, and `10000/udp` in both the host firewall and hosting-provider firewall;
- a current desktop Chrome or Edge for clients.

Port `10000/udp` is the Jitsi Videobridge media path. A reverse proxy does not replace it. Add a TURN server over TCP/TLS if clients must work from networks that block UDP.

The production layout is:

```text
Internet -> Caddy :443 -> Ninjitsi 127.0.0.1:3000
                       -> Jitsi    127.0.0.1:8000
Internet -> JVB :10000/udp
```

Ninjitsi and Jitsi share one JWT secret. Ninjitsi issues a short-lived, room-scoped token only after its room API admits the user. Jitsi rejects tokenless connections, so opening the Jitsi domain directly does not bypass a Ninjitsi room password.

## Add Ninjitsi to an existing Docker Jitsi

Do not uninstall Docker and do not replace the virtual machine. Ninjitsi runs as
a separate Compose project beside the existing Jitsi project. The Jitsi domain,
Videobridge, UDP port 10000, and existing reverse proxy remain in place.

The recommended production migration changes Jitsi from open admission to JWT
admission. Schedule a maintenance window: recreating the Jitsi containers ends
active meetings, and direct tokenless access to the standard Jitsi UI stops
working after the cutover.

These steps assume the existing installation uses the official
`docker-jitsi-meet` Compose project. If Jitsi was installed from Debian packages,
Kubernetes, or a third-party image, do not copy these environment variables
blindly; follow that installation's token-authentication procedure instead.

### 1. Inventory the existing installation

Find the directory containing Jitsi's `.env` and `docker-compose.yml`, then run:

```bash
cd /path/to/existing/docker-jitsi-meet
sudo docker compose ps
sudo docker compose config --services
sudo docker compose images
grep -E '^(PUBLIC_URL|CONFIG|JITSI_IMAGE_VERSION|XMPP_DOMAIN|ENABLE_AUTH|AUTH_TYPE|ENABLE_GUESTS|JWT_APP_ID|JWT_ALLOW_EMPTY)=' .env
sudo ss -lunp | grep ':10000'
```

Record the following before changing anything:

- the absolute Jitsi Compose directory;
- its release and container image versions;
- `PUBLIC_URL`, which becomes Ninjitsi's `JITSI_URL`;
- `XMPP_DOMAIN`, which becomes Ninjitsi's `JITSI_JWT_SUBJECT` and defaults to
  `meet.jitsi` when absent;
- the `CONFIG` directory and any additional Compose override files;
- the current reverse proxy and certificate manager;
- whether Jitsi already uses JWT, internal, LDAP, or open authentication.

Ninjitsi is tested with `docker-jitsi-meet stable-11146-2`. Do not combine a
Compose file from one release with images from another. If the existing release
is materially older, upgrade Jitsi separately according to the official release
notes, prove an ordinary call still works, and only then start this migration.

If Jitsi already uses JWT for another application, reuse its `JWT_APP_ID`,
`JWT_APP_SECRET`, accepted audience, and XMPP subject in Ninjitsi. Replacing them
would invalidate the existing application's tokens. An internal or LDAP setup
also needs an explicit authentication migration plan; switching `AUTH_TYPE`
removes that login path.

### 2. Back up Jitsi and prepare rollback

Create a protected backup directory and copy the Compose configuration into it:

```bash
MIGRATION_BACKUP="/var/backups/ninjitsi-migration-$(date +%F-%H%M%S)"
sudo install -d -m 0700 "$MIGRATION_BACKUP"

cd /path/to/existing/docker-jitsi-meet
sudo cp -a .env docker-compose.yml "$MIGRATION_BACKUP"/
for file in docker-compose.override.yml *.yml; do
  [ ! -e "$file" ] || sudo cp -a --no-clobber "$file" "$MIGRATION_BACKUP"/
done
sudo docker compose images | \
  sudo tee "$MIGRATION_BACKUP/jitsi-images.txt" >/dev/null
grep '^CONFIG=' .env
echo "$MIGRATION_BACKUP"
```

Back up the absolute directory printed by `CONFIG` as well. It contains generated
Prosody, Jicofo, JVB, and web state and is installation-specific. For example,
if `CONFIG=/opt/jitsi-meet-cfg`:

```bash
sudo tar -C /opt -czf "$MIGRATION_BACKUP/jitsi-meet-cfg.tgz" jitsi-meet-cfg
```

After creating the admission secret in the next step, copy the resulting backup
off the virtual machine. It contains service passwords and the admission secret.

### 3. Create or reuse the shared JWT secret

For a previously open Jitsi installation, create a new secret:

```bash
sudo install -d -m 0755 /opt/ninjitsi
umask 077
openssl rand -hex 32 | sudo tee /opt/ninjitsi/jitsi-jwt-secret >/dev/null
sudo chmod 0600 /opt/ninjitsi/jitsi-jwt-secret
sudo cp -a /opt/ninjitsi/jitsi-jwt-secret "$MIGRATION_BACKUP"/
```

If Jitsi already uses JWT, place its existing secret in that file instead; do not
generate a replacement. Keep the file root-readable only, and refresh the
off-server backup after copying the secret into it.

### 4. Convert an open Jitsi installation to token-only admission

Skip this step when the existing Jitsi already uses the required JWT settings.
Open its `.env` with `sudoedit` and set each variable exactly once. Remove or
update an older occurrence instead of appending duplicate keys.

```dotenv
ENABLE_AUTH=1
ENABLE_GUESTS=0
AUTH_TYPE=jwt
JWT_APP_ID=ninjitsi
JWT_APP_SECRET=replace-with-the-value-from-jitsi-jwt-secret
JWT_ACCEPTED_ISSUERS=ninjitsi
JWT_ACCEPTED_AUDIENCES=ninjitsi
JWT_ALLOW_EMPTY=0
JWT_AUTH_TYPE=token
JWT_TOKEN_AUTH_MODULE=token_verification
PROSODY_ENABLE_RATE_LIMITS=1
```

`JWT_ALLOW_EMPTY=0` is essential: with an empty token allowed, a visitor can
bypass the Ninjitsi room password by opening the Jitsi domain directly. Validate
the effective configuration without printing it—the expanded Compose output
contains secrets—then recreate Jitsi during the maintenance window:

```bash
cd /path/to/existing/docker-jitsi-meet
sudo docker compose config --quiet
sudo docker compose up -d --force-recreate
sudo docker compose ps
sudo docker compose logs --tail=100 web prosody jicofo jvb
```

All core containers must remain running. A direct visit to the Jitsi domain may
still render its landing page, but joining a room without a valid token must fail.

### 5. Install Ninjitsi as a separate Compose project

```bash
sudo install -d -m 0755 -o "$USER" -g "$USER" /opt/ninjitsi/app
git clone https://github.com/Philippsapegin/ninjitsi.git /opt/ninjitsi/app
cd /opt/ninjitsi/app

JITSI_JWT_SECRET=$(sudo cat /opt/ninjitsi/jitsi-jwt-secret | tr -d '\r\n')
sudo tee .env >/dev/null <<EOF
JITSI_URL=https://jitsi.example.com
NINJITSI_PORT=127.0.0.1:3000

JITSI_AUTH_MODE=token
JITSI_JWT_APP_ID=ninjitsi
JITSI_JWT_AUDIENCE=ninjitsi
JITSI_JWT_SUBJECT=meet.jitsi
JITSI_JWT_SECRET=${JITSI_JWT_SECRET}
JITSI_JWT_TTL_SECONDS=43200

MAX_ROOMS=10000
ROOM_TTL_HOURS=720
ROOM_CREATE_RATE_LIMIT=10
ROOM_CREATE_RATE_WINDOW_SECONDS=600
ROOM_CREATE_GLOBAL_RATE_LIMIT=120
ROOM_JOIN_RATE_LIMIT=30
ROOM_JOIN_GLOBAL_RATE_LIMIT=600
ROOM_PASSWORD_RATE_LIMIT=10
ROOM_LOOKUP_RATE_LIMIT=120
SCRYPT_MAX_CONCURRENCY=2
SCRYPT_MAX_QUEUE=8
TRUST_PROXY=1
EOF
sudo chmod 0600 .env

sudo docker compose config --quiet
sudo docker compose up -d --build
sudo docker compose ps
curl --fail --show-error --retry 30 --retry-delay 1 --retry-all-errors \
  http://127.0.0.1:3000/api/health
```

Replace `JITSI_URL` with the existing public Jitsi HTTPS URL. Use the existing
issuer as `JITSI_JWT_APP_ID`, one of Jitsi's accepted audiences as
`JITSI_JWT_AUDIENCE`, and the existing `XMPP_DOMAIN` as `JITSI_JWT_SUBJECT`.
For a previously open installation using the defaults, the shown values are
correct. The health response must contain `"ok":true` and
`"authMode":"token"`.

Ninjitsi does not need to join the Jitsi Docker network: clients load
`lib-jitsi-meet` and establish XMPP/media connections through Jitsi's existing
public HTTPS domain. Keep port 3000 bound to `127.0.0.1`; do not publish it
directly to the Internet.

### 6. Add the Ninjitsi hostname to the existing reverse proxy

Create a DNS `A` record such as `call.example.com` for the same virtual machine.
Leave the working Jitsi proxy configuration untouched and add one virtual host
that forwards the new hostname to `127.0.0.1:3000`.

For Caddy, merge this block into the existing Caddyfile:

```caddyfile
call.example.com {
    encode zstd gzip
    header {
        Strict-Transport-Security "max-age=31536000"
        -Server
    }
    reverse_proxy 127.0.0.1:3000 {
        stream_close_delay 5m
    }
}
```

Then run `sudo caddy validate --config /etc/caddy/Caddyfile` and reload Caddy.
For Nginx, add an equivalent HTTPS server through the installation's existing
certificate workflow:

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name call.example.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

Validate with `sudo nginx -t` before reloading. Do not replace the existing Jitsi
WebSocket locations or its UDP 10000 routing; Ninjitsi depends on those paths.

### 7. Verify the migrated installation

```bash
curl --fail --show-error https://call.example.com/api/health
curl --fail --show-error --head https://jitsi.example.com/config.js
curl --fail --show-error --head \
  https://jitsi.example.com/libs/lib-jitsi-meet.min.js
sudo ss -lntup | grep -E ':(80|443|3000|10000)\b'
```

Create a password-protected room through Ninjitsi and test with a second computer
on another network. Confirm audio, video, screen sharing, chat, reconnect, and
three-participant media. Also confirm that the same Jitsi room cannot be joined
directly without a token. The forced-JVB test under **Technical checks** proves
that a passing two-person P2P call is not hiding a broken Videobridge route.

### Temporary compatibility test without changing Jitsi authentication

To evaluate the UI before scheduling the JWT cutover, Ninjitsi can temporarily
use an existing open Jitsi. In Ninjitsi's `.env`, set:

```dotenv
JITSI_AUTH_MODE=open
JITSI_JWT_SECRET=an-unused-random-secret-required-by-the-compose-model
```

Restart Ninjitsi with `sudo docker compose up -d`. This mode is not a secure
production deployment: Ninjitsi room passwords protect only the Ninjitsi entry
page, while anyone who knows the room name can bypass it through the ordinary
Jitsi interface. Finish the JWT migration before inviting users.

### Roll back the migration

Stop Ninjitsi, restore the backed-up Jitsi `.env`, Compose overrides, and
`CONFIG` directory, then recreate the original Jitsi stack using the image
versions recorded during inventory:

```bash
cd /opt/ninjitsi/app
sudo docker compose down

cd /path/to/existing/docker-jitsi-meet
# Restore the saved files from $MIGRATION_BACKUP before continuing.
sudo docker compose config --quiet
sudo docker compose up -d --force-recreate
sudo docker compose ps
```

Finally remove or disable only the `call.example.com` reverse-proxy block. Do not
delete the existing Jitsi volumes, configuration directory, or Docker Engine.

## Fresh server installation and launch

Replace these examples throughout the instructions:

```text
call.example.com     public Ninjitsi domain
jitsi.example.com   public Jitsi domain
203.0.113.10        public IPv4 address of the server
admin@example.com   certificate notification email
```

### 1. Prepare DNS and firewall

Create `A` records for both domains. Create `AAAA` records only when IPv6 is routed to the server and Docker is configured for it.

```bash
getent ahostsv4 call.example.com
getent ahostsv4 jitsi.example.com
```

Open the public ports. Keep SSH limited to trusted addresses when possible.
Replace `22` below if the server uses a different SSH port; verify the SSH rule
before enabling UFW so that the current session is not locked out.

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 10000/udp
sudo ufw enable
sudo ufw status
```

The application HTTP ports are bound to `127.0.0.1`, so only Caddy can reach them publicly.

### 2. Install Docker and tools

```bash
sudo apt update
sudo apt install -y ca-certificates curl git unzip openssl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io \
  docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo docker run --rm hello-world
sudo docker compose version
```

The remaining examples use `sudo docker`. Membership in the `docker` group is root-equivalent and is not required.

### 3. Download Ninjitsi and Jitsi

Ninjitsi is tested against the official `docker-jitsi-meet stable-11146-2` release.
Keep this version pinned until a newer Jitsi release has passed the media checks
at the end of this document.

```bash
sudo mkdir -p /opt/ninjitsi
sudo chown "$USER":"$USER" /opt/ninjitsi
cd /opt/ninjitsi
git clone https://github.com/Philippsapegin/ninjitsi.git

JITSI_RELEASE=stable-11146-2
curl -fL \
  "https://github.com/jitsi/docker-jitsi-meet/archive/refs/tags/${JITSI_RELEASE}.zip" \
  -o docker-jitsi-meet.zip
unzip docker-jitsi-meet.zip
mv "docker-jitsi-meet-${JITSI_RELEASE}" jitsi
rm docker-jitsi-meet.zip
```

Do not deploy Jitsi from its development branch. The release archive and container image version must match.

### 4. Configure JWT-protected Jitsi

Generate one shared admission secret and protect it from other host users:

```bash
umask 077
openssl rand -hex 32 > /opt/ninjitsi/jitsi-jwt-secret
```

Prepare Jitsi's internal service passwords and rootless directory layout:

```bash
cd /opt/ninjitsi/jitsi
cp env.example .env
./gen-passwords.sh

mkdir -p /opt/ninjitsi/jitsi-config/{web,prosody/config,prosody/prosody-plugins-custom,jicofo,jvb,jigasi,jibri,transcriber}
mkdir -p /opt/ninjitsi/jitsi-config/storage/{jibri,prosody,transcripts,web}
mkdir -p /opt/ninjitsi/jitsi-config/tmp/{web-crontabs,web-load-test}
chmod 0777 /opt/ninjitsi/jitsi-config/storage/{jibri,prosody,transcripts,web}
chmod 0777 /opt/ninjitsi/jitsi-config/tmp/{web-crontabs,web-load-test}
```

Append the production settings. `JVB_ADVERTISE_IPS` must be the public server address, not a Docker or LAN address.

```bash
JITSI_JWT_SECRET=$(tr -d '\r\n' < /opt/ninjitsi/jitsi-jwt-secret)

cat >> .env <<EOF

# Ninjitsi production settings
CONFIG=/opt/ninjitsi/jitsi-config
JITSI_IMAGE_VERSION=stable-11146-2
RESTART_POLICY=unless-stopped
HTTP_PORT=127.0.0.1:8000
HTTPS_PORT=127.0.0.1:8443
TZ=UTC
PUBLIC_URL=https://jitsi.example.com
JVB_ADVERTISE_IPS=203.0.113.10
DISABLE_HTTPS=1
ENABLE_HTTP_REDIRECT=0
ENABLE_LETSENCRYPT=0
ENABLE_PREJOIN_PAGE=0
ENABLE_WELCOME_PAGE=0

# Only Ninjitsi-issued room tokens may join.
ENABLE_AUTH=1
ENABLE_GUESTS=0
AUTH_TYPE=jwt
JWT_APP_ID=ninjitsi
JWT_APP_SECRET=${JITSI_JWT_SECRET}
JWT_ACCEPTED_ISSUERS=ninjitsi
JWT_ACCEPTED_AUDIENCES=ninjitsi
JWT_ALLOW_EMPTY=0
JWT_AUTH_TYPE=token
JWT_TOKEN_AUTH_MODULE=token_verification

# Keep abuse protection without throttling normal WebRTC renegotiation. The
# Docker proxy range must not be treated as one external client IP.
PROSODY_ENABLE_RATE_LIMITS=1
PROSODY_RATE_LIMIT_SESSION_RATE=10000
PROSODY_RATE_LIMIT_TIMEOUT=10
PROSODY_RATE_LIMIT_ALLOW_RANGES=10.0.0.0/8,127.0.0.1,172.16.0.0/12

# Conservative desktop baseline. It avoids codec switches during camera and
# screen-share replacement; enable other codecs later only after a media test.
CODEC_ORDER_JVB=["VP8"]
CODEC_ORDER_JVB_MOBILE=["VP8"]
CODEC_ORDER_P2P=["VP8"]
CODEC_ORDER_P2P_MOBILE=["VP8"]
ENABLE_CODEC_VP8=1
ENABLE_CODEC_VP9=0
ENABLE_CODEC_AV1=0
ENABLE_CODEC_H264=0
EOF

cp /opt/ninjitsi/ninjitsi/deploy/jitsi-compose.override.yml \
  /opt/ninjitsi/jitsi/docker-compose.override.yml
```

These lines intentionally come last in `.env` and override matching defaults
from the release archive. Keep `JITSI_IMAGE_VERSION` equal to the downloaded
release directory.

The override bounds Docker log growth. Validate the effective configuration before starting anything:

```bash
sudo docker compose config --quiet
sudo docker compose up -d
sudo docker compose ps
sudo docker compose logs --tail=100 web prosody jicofo jvb
```

All four services must remain healthy/running. The current Jitsi release runs them as unprivileged users with read-only container filesystems; missing or unwritable `storage` and `tmp` directories cause an intentional startup failure.

### 5. Configure and start Ninjitsi

Use the same JWT secret:

```bash
cd /opt/ninjitsi/ninjitsi
JITSI_JWT_SECRET=$(tr -d '\r\n' < /opt/ninjitsi/jitsi-jwt-secret)

cat > .env <<EOF
JITSI_URL=https://jitsi.example.com
NINJITSI_PORT=127.0.0.1:3000

JITSI_AUTH_MODE=token
JITSI_JWT_APP_ID=ninjitsi
JITSI_JWT_AUDIENCE=ninjitsi
JITSI_JWT_SUBJECT=meet.jitsi
JITSI_JWT_SECRET=${JITSI_JWT_SECRET}
JITSI_JWT_TTL_SECONDS=43200

MAX_ROOMS=10000
ROOM_TTL_HOURS=720
ROOM_CREATE_RATE_LIMIT=10
ROOM_CREATE_RATE_WINDOW_SECONDS=600
ROOM_CREATE_GLOBAL_RATE_LIMIT=120
ROOM_JOIN_RATE_LIMIT=30
ROOM_JOIN_GLOBAL_RATE_LIMIT=600
ROOM_PASSWORD_RATE_LIMIT=10
ROOM_LOOKUP_RATE_LIMIT=120
SCRYPT_MAX_CONCURRENCY=2
SCRYPT_MAX_QUEUE=8
TRUST_PROXY=1
EOF
chmod 0600 .env

sudo docker compose config --quiet
sudo docker compose up -d --build
sudo docker compose ps
curl --fail --show-error --retry 30 --retry-delay 1 --retry-all-errors \
  http://127.0.0.1:3000/api/health
```

The health response must contain `"ok":true` and `"authMode":"token"`. A one-shot, networkless `data-init` container fixes ownership of registries created by pre-rootless releases and exits. The long-running Ninjitsi container runs as uid 1000, drops all capabilities, has a read-only root filesystem, and writes only the room registry volume.

New room codes contain a 96-bit random hexadecimal suffix. Rooms expire after `ROOM_TTL_HOURS` and are pruned automatically. Reaching `MAX_ROOMS` returns an error; active records are never evicted to make room for an attacker.

### 6. Add public HTTPS with Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring \
  apt-transport-https curl gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
  sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' |
  sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy

sudo install -m 0644 /opt/ninjitsi/ninjitsi/deploy/Caddyfile.example \
  /etc/caddy/Caddyfile
sudoedit /etc/caddy/Caddyfile
```

Replace both example domains and the email. Then validate and reload:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

Caddy obtains trusted certificates and proxies Jitsi's XMPP and Colibri WebSockets. `stream_close_delay` prevents a Caddy configuration reload from immediately terminating every long-lived WebSocket.

### 7. Production verification

```bash
curl --fail --show-error https://call.example.com/api/health
curl --fail --show-error --head https://jitsi.example.com/config.js
curl --fail --show-error --head https://jitsi.example.com/libs/lib-jitsi-meet.min.js
curl --fail --silent --show-error --head https://call.example.com | \
  grep -Ei 'strict-transport-security|content-security-policy|permissions-policy|x-content-type-options'
sudo ss -lntup | grep -E ':(80|443|3000|8000|8443|10000)\b'
sudo docker compose -f /opt/ninjitsi/ninjitsi/compose.yaml \
  --env-file /opt/ninjitsi/ninjitsi/.env exec -T web id
```

Only Caddy should listen publicly on TCP 80/443; the Ninjitsi and Jitsi HTTP backends should show `127.0.0.1`. JVB must listen on UDP 10000.

Create a password-protected room at `https://call.example.com`. Verify all of the following before inviting users:

1. the room URL works from a second computer on another network;
2. an incorrect password is rejected by Ninjitsi;
3. entering the same room directly through the Jitsi UI without a JWT is rejected;
4. both sides receive audio/video, screen sharing, chat, and attachments;
5. reconnecting Wi-Fi restores the meeting;
6. a forced JVB call remains connected for the required six-hour acceptance period.

Camera, microphone, and screen sharing require trusted HTTPS. If two-person calls work but JVB calls fail, inspect `JVB_ADVERTISE_IPS`, UDP 10000, NAT forwarding, and JVB logs. TURN is required for clients whose networks block UDP.

If browser logs contain a `Jingle IQ` timeout, check Prosody for `rate exceeded`
or `throttling session` at the same timestamp. The production values above
retain per-session abuse protection while allowing the larger signaling bursts
caused by adding, replacing, and removing camera or screen-share tracks. Do not
leave the Docker proxy subnet under the aggregate per-IP limiter: every browser
would otherwise appear to Prosody as the same proxy address.

### Diagnosing `conference.iceFailed`

This error means that the browser could not establish or keep a WebRTC media
path; it is not a Ninjitsi room timeout. A two-person meeting can use Jitsi P2P
and therefore does not prove that Videobridge is reachable. Reproduce the issue
with three participants or with `NINJITSI_FORCE_JVB=1` in the automated media
test, then inspect the server while the failure is current:

```bash
sudo ss -lunp | grep ':10000'
cd /opt/ninjitsi/jitsi
sudo docker compose ps
sudo docker compose logs --since=15m prosody jicofo jvb
```

Check that `JVB_ADVERTISE_IPS` contains the server's public address, that UDP
10000 reaches that address through every provider firewall and NAT rule, and
that the JVB container has not restarted or exhausted memory. Test from a
second physical network, not only from the server or its LAN. If UDP is blocked
by a client network, deploy and configure TURN over TCP/TLS; opening more HTTP
ports or increasing room TTL cannot repair an ICE path.

## Operations

### Logs and health

```bash
cd /opt/ninjitsi/ninjitsi
sudo docker compose ps
sudo docker compose logs -f --tail=100

cd /opt/ninjitsi/jitsi
sudo docker compose ps
sudo docker compose logs -f --tail=100 web prosody jicofo jvb
```

Monitor `https://call.example.com/api/health`, Docker container health, disk usage, RAM, and UDP/JVB reachability from an external monitoring system. Application health alone cannot prove that media traversal works.

### Backup and restore

The room registry is stored in the `ninjitsi_ninjitsi-data` volume. Chat and attachments are conference-only and are not backed up.

```bash
sudo install -d -m 0700 /var/backups/ninjitsi
sudo docker run --rm \
  -v ninjitsi_ninjitsi-data:/data:ro \
  -v /var/backups/ninjitsi:/backup \
  alpine tar -C /data -czf /backup/ninjitsi-data-$(date +%F-%H%M%S).tgz .

sudo tar -C /opt/ninjitsi -czf \
  /var/backups/ninjitsi/ninjitsi-config-$(date +%F-%H%M%S).tgz \
  jitsi/.env jitsi-config jitsi-jwt-secret ninjitsi/.env
sudo find /var/backups/ninjitsi -maxdepth 1 -type f \
  -name 'ninjitsi-*.tgz' -exec chmod 0600 {} +
```

The second archive contains service passwords and the shared JWT secret. Encrypt it before copying it off the meeting server. Automate both commands with a systemd timer or backup service and test restoration periodically. To restore a selected room-registry archive:

```bash
cd /opt/ninjitsi/ninjitsi
sudo docker compose stop web
sudo docker run --rm \
  -v ninjitsi_ninjitsi-data:/data \
  -v /var/backups/ninjitsi:/backup:ro \
  alpine tar -C /data -xzf /backup/ninjitsi-data-YYYY-MM-DD-HHMMSS.tgz
sudo docker compose run --rm data-init
sudo docker compose start web
curl --fail --show-error --retry 30 --retry-delay 1 --retry-all-errors \
  http://127.0.0.1:3000/api/health
```

Restoration overwrites `rooms.json` with the archived registry. Keep the current file as a backup before restoring older data. The configuration archive is for disaster recovery: install the same pinned Jitsi release, stop both stacks, restore its paths under `/opt/ninjitsi`, and only then start the services.

### Update and rollback

Back up the room registry and record the current revision before updating:

```bash
cd /opt/ninjitsi/ninjitsi
git rev-parse HEAD | tee /opt/ninjitsi/ninjitsi-last-good-revision
sudo docker image tag ninjitsi-web:latest ninjitsi-web:rollback
git pull --ff-only
sudo docker compose config --quiet
sudo docker compose build
sudo docker compose up -d
curl --fail --show-error --retry 30 --retry-delay 1 --retry-all-errors \
  https://call.example.com/api/health
```

If the new application image fails, restore the previous image without rebuilding:

```bash
cd /opt/ninjitsi/ninjitsi
sudo docker compose stop web
sudo docker image tag ninjitsi-web:rollback ninjitsi-web:latest
git checkout --detach "$(cat /opt/ninjitsi/ninjitsi-last-good-revision)"
sudo docker compose config --quiet
sudo docker compose up -d --no-build
curl --fail --show-error --retry 30 --retry-delay 1 --retry-all-errors \
  http://127.0.0.1:3000/api/health
```

Restore the room backup as well only when a release changed the stored schema and its release notes explicitly require it.
After resolving the failed update, return the checkout to the release branch
with `git switch main` before attempting a later update.

Upgrade Jitsi separately, following the selected release notes and official Docker migration guide. Keep `/opt/ninjitsi/jitsi-config`, the generated service passwords, and the shared JWT secret. Never rotate `JWT_APP_SECRET` on only one side: Jitsi and Ninjitsi must change together during a maintenance window.

## Client instructions

Nothing is installed on the client computer.

1. The creator opens `https://call.example.com` in current desktop Chrome or Edge.
2. They select or create a local profile, optionally enter a room password, and select **Create room**.
3. Ninjitsi creates the room and opens a direct URL such as `https://call.example.com/room/quiet-studio-0123456789abcdef01234567`.
4. The creator sends that URL to guests. A room password, when used, should be sent separately.
5. A guest opens the link, selects a profile, enters the password, and selects **Join room**.
6. On first use, the guest allows camera and microphone access. Screen sharing opens the browser/system picker.

Profiles and avatars remain in that browser's local storage. A server-issued Jitsi token remains only in the active page and expires after twelve hours by default.

## Features

- **Local profiles:** reusable names and avatars stored in the client's browser.
- **Adaptive grid and stage mode:** every video tile remains 16:9; selecting a tile promotes it to a stage.
- **Noise suppression:** optional RNNoise processing through the Jitsi audio-track effect API.
- **Private messages and replies:** text and attachments can target selected participants; private replies retain their recipient set.
- **Personal volume:** every remote participant can be adjusted locally from 0% to 200%; local microphone audio is never attached to local output.
- **Chat attachments:** drag-and-drop or file-picker delivery up to 2 MB; images open in an in-app preview and transparent PNGs retain alpha.
- **Meeting alerts:** participant, message, and initial-room sounds plus unread-chat indication.
- **Bilingual interface:** English by default, with English/Russian switching on the landing page and in meeting settings.

## Technical checks

Repository checks require Node.js 22.20 or newer and npm 10 or newer:

```bash
npm ci
npm audit --audit-level=moderate
npm test
npm run lint
npm run typecheck
npm run build:cloudflare
```

`npm test` covers room-code entropy, rate limiting, `scrypt` concurrency, JWT signatures and claims, expiration migration, non-evicting capacity, security headers, and admission-token issuance.

Validate the production Compose model without printing its expanded secret:

```bash
JITSI_JWT_SECRET=$(openssl rand -hex 32) docker compose config --quiet
```

For a disposable local Jitsi + Ninjitsi stack:

```powershell
# Windows PowerShell
npm run stack:up
npm run stack:status
```

```bash
# Linux
./scripts/stack.sh up
./scripts/stack.sh status
```

The scripts download the pinned Jitsi release into `.local/`, generate a shared JWT secret, configure token-only admission, create the rootless directory layout, and start Ninjitsi at `http://localhost:3000` with Jitsi at `http://localhost:8000`.

With Ninjitsi running:

```bash
npm run smoke:rooms
npm run smoke:profiles
npm run smoke:visual
```

Run the real media suite against a reachable Jitsi instance:

```bash
NINJITSI_BASE_URL=http://localhost:3000 \
NINJITSI_JITSI_URL=http://localhost:8000 \
NINJITSI_FORCE_JVB=1 \
npm run smoke:jitsi
```

For the required six-hour transport check:

```bash
NINJITSI_STABILITY_MS=21600000 \
NINJITSI_BASE_URL=https://call.example.com \
NINJITSI_JITSI_URL=https://jitsi.example.com \
NINJITSI_FORCE_JVB=1 \
npm run smoke:jitsi
```

`NINJITSI_FORCE_JVB=1` disables P2P in the test clients so the run actually
exercises the server media path. The media suite verifies token-only admission,
publication and reception of camera/microphone tracks, absence of local audio
playback, screen sharing, private chat isolation, replies, attachments, stable
grid behavior, per-participant volume, connection statistics, stage mode,
device switching, noise suppression, and transport recovery. A production
acceptance run still needs real devices on at least two physical networks; a
browser on the Docker host cannot prove NAT, firewall, TURN, acoustic, or
six-hour Internet behavior.

Official references: [Jitsi Docker deployment](https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-docker/), [Jitsi token authentication](https://jitsi.github.io/handbook/docs/devops-guide/token-authentication/), [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/), and [Caddy installation](https://caddyserver.com/docs/install#debian-ubuntu-raspbian).
