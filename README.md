# Ninjitsi

Ninjitsi is a desktop-first web client for a self-hosted Jitsi deployment: it keeps every participant in a responsive 16:9 grid, removes the standard Jitsi interface, and adds a small room server, local profiles, chat, stage mode, device controls, and per-participant audio controls. Guests only need a current desktop browser and a room link; no Ninjitsi or Jitsi software is installed on their computers.

## Requirements

For a public production installation:

- a 64-bit Linux server; Ubuntu 24.04 LTS is the documented example;
- at least 2 CPU cores, 4 GB RAM, and 20 GB free disk for a small meeting server;
- root or `sudo` access;
- Docker Engine with the Docker Compose v2 plugin;
- Git, `curl`, `unzip`, and OpenSSL;
- two DNS names pointing to the server, for example `call.example.com` for Ninjitsi and `jitsi.example.com` for Jitsi;
- inbound `80/tcp`, `443/tcp`, and `10000/udp` allowed both in the host firewall and the hosting provider's security group;
- a current desktop Chrome or Edge on client computers.

`10000/udp` is the Jitsi Videobridge media path and is required even when HTTP is behind a reverse proxy. If users must connect from networks that block UDP, configure a TURN server over TCP/TLS before calling the deployment production-ready. The reference Jitsi Docker installation supports `amd64` and `arm64`.

## Server installation and launch

The commands below install Ninjitsi and Jitsi on one Ubuntu server. Replace these example values everywhere:

```text
call.example.com      public Ninjitsi address
jitsi.example.com    public Jitsi address
203.0.113.10         server public IPv4 address
admin@example.com    certificate notification email
```

### 1. Prepare DNS and network access

Create `A` records for both names with the public IPv4 address of the server. Create matching `AAAA` records only when IPv6 is actually routed to the host and Docker is configured for it. Wait until both names resolve correctly:

```bash
getent ahostsv4 call.example.com
getent ahostsv4 jitsi.example.com
```

Open the required ports in the cloud firewall/security group. If UFW is in use:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 10000/udp
sudo ufw enable
sudo ufw status
```

Docker-published ports can bypass some UFW rules. The configuration below therefore binds the private HTTP backends to `127.0.0.1`; only Caddy and Jitsi media are public.

### 2. Install Docker Engine and tools

Install Docker from Docker's official Ubuntu repository:

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

The remaining examples use `sudo docker`. Adding an account to the `docker` group grants it root-equivalent access and is optional.

### 3. Download Ninjitsi

```bash
sudo mkdir -p /opt/ninjitsi
sudo chown "$USER":"$USER" /opt/ninjitsi
cd /opt/ninjitsi
git clone https://github.com/Philippsapegin/ninjitsi.git
```

### 4. Install the matching Jitsi release

Ninjitsi's local stack is tested against `docker-jitsi-meet stable-11031`. Download the release archive rather than the development branch:

```bash
cd /opt/ninjitsi
curl -fL \
  https://github.com/jitsi/docker-jitsi-meet/archive/refs/tags/stable-11031.zip \
  -o docker-jitsi-meet.zip
unzip docker-jitsi-meet.zip
mv docker-jitsi-meet-stable-11031 jitsi
rm docker-jitsi-meet.zip

cd /opt/ninjitsi/jitsi
cp env.example .env
./gen-passwords.sh
mkdir -p /opt/ninjitsi/jitsi-config/{web,transcripts,prosody/config,prosody/prosody-plugins-custom,jicofo,jvb,jigasi,jibri}
```

Append the production settings. Use the server's public IP for `JVB_ADVERTISE_IPS`, not a Docker, LAN, or reverse-proxy address:

```bash
cat >> .env <<'EOF'

# Ninjitsi production settings
CONFIG=/opt/ninjitsi/jitsi-config
HTTP_PORT=8000
HTTPS_PORT=8443
TZ=UTC
PUBLIC_URL=https://jitsi.example.com
JVB_ADVERTISE_IPS=203.0.113.10
DISABLE_HTTPS=1
ENABLE_HTTP_REDIRECT=0
ENABLE_LETSENCRYPT=0
ENABLE_PREJOIN_PAGE=0
ENABLE_WELCOME_PAGE=0
EOF
```

Caddy will terminate HTTPS, so Jitsi stays on private HTTP. Restrict both Jitsi web mappings to loopback:

```bash
sed -i \
  -e "s/'\${HTTP_PORT}:80'/'127.0.0.1:\${HTTP_PORT}:80'/" \
  -e "s/'\${HTTPS_PORT}:443'/'127.0.0.1:\${HTTPS_PORT}:443'/" \
  docker-compose.yml
```

Review the effective values and start Jitsi:

```bash
sudo docker compose config | grep -E \
  'PUBLIC_URL|JVB_ADVERTISE_IPS|published|host_ip'
sudo docker compose up -d
sudo docker compose ps
```

All four core services—`web`, `prosody`, `jicofo`, and `jvb`—must be running. Do not continue if one repeatedly restarts:

```bash
sudo docker compose logs --tail=100 web prosody jicofo jvb
```

### 5. Build and start Ninjitsi

```bash
cd /opt/ninjitsi/ninjitsi
cat > .env <<'EOF'
JITSI_URL=https://jitsi.example.com
NINJITSI_PORT=127.0.0.1:3000
MAX_ROOMS=10000
EOF

sudo docker compose up -d --build
sudo docker compose ps
curl --fail http://127.0.0.1:3000/api/health
```

The `ninjitsi-data` Docker volume contains the room registry and survives container replacement. Room passwords are stored as salted scrypt hashes, never as plaintext.

### 6. Add public HTTPS with Caddy

Install the official Caddy package:

```bash
sudo apt install -y debian-keyring debian-archive-keyring \
  apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' |
  sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' |
  sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

Create `/etc/caddy/Caddyfile`:

```caddyfile
{
    email admin@example.com
}

call.example.com {
    reverse_proxy 127.0.0.1:3000
}

jitsi.example.com {
    reverse_proxy 127.0.0.1:8000
}
```

Caddy forwards the Jitsi XMPP and Colibri WebSockets automatically. Validate and reload:

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

Caddy obtains trusted TLS certificates after DNS and ports 80/443 are working. Verify the public endpoints:

```bash
curl --fail https://call.example.com/api/health
curl --fail --head https://jitsi.example.com/config.js
curl --fail --head \
  https://jitsi.example.com/libs/lib-jitsi-meet.min.js
sudo ss -lunp | grep ':10000'
```

Open `https://call.example.com`, create a room, and join its link from a second computer on a different network. Camera/microphone access and screen sharing require trusted HTTPS. If two-person calls work but larger meetings lose media, check `JVB_ADVERTISE_IPS`, the `10000/udp` rule, NAT forwarding, and `sudo docker compose logs jvb`.

### 7. Operations and updates

View logs:

```bash
cd /opt/ninjitsi/ninjitsi
sudo docker compose logs -f --tail=100

cd /opt/ninjitsi/jitsi
sudo docker compose logs -f --tail=100 web prosody jicofo jvb
```

Restart without deleting persistent data:

```bash
cd /opt/ninjitsi/jitsi && sudo docker compose restart
cd /opt/ninjitsi/ninjitsi && sudo docker compose restart
```

Update Ninjitsi:

```bash
cd /opt/ninjitsi/ninjitsi
git pull --ff-only
sudo docker compose up -d --build
curl --fail https://call.example.com/api/health
```

Back up the room registry:

```bash
cd /opt/ninjitsi
sudo docker run --rm \
  -v ninjitsi_ninjitsi-data:/data:ro \
  -v "$PWD":/backup \
  alpine tar -C /data -czf /backup/ninjitsi-data.tgz .
```

Upgrade Jitsi by following its release notes and official Docker upgrade procedure; keep `/opt/ninjitsi/jitsi-config` and the generated secrets. Do not replace a production Jitsi release with the repository's development branch.

Reference documentation: [Docker Engine on Ubuntu](https://docs.docker.com/engine/install/ubuntu/), [Jitsi Docker deployment](https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-docker/), and [Caddy installation](https://caddyserver.com/docs/install#debian-ubuntu-raspbian).

## Client instructions

Nothing is installed on the client computer.

1. The room creator opens `https://call.example.com` in a current desktop Chrome or Edge.
2. They choose or create a local profile, optionally enter a room password, and select **Create room**.
3. Ninjitsi creates the room and opens a direct URL such as `https://call.example.com/room/quiet-studio-04210`.
4. The creator copies that URL from the address bar or the copy-link button and sends it to the guests. The password, when present, must be sent separately.
5. A guest opens the link, selects or creates a profile, enters the password when required, and selects **Join room**.
6. On first use, the guest allows microphone and camera access. Screen sharing opens a separate browser/system picker.
7. Devices and noise suppression can be changed from the settings button during the meeting. No account is required.

Profiles and avatars stay only in that browser's local storage. Chat messages and attachments live only in the active conference and are not uploaded to the Ninjitsi room server.

## Features

- **Local profiles:** reusable display names and avatars stored in the client's browser, with profile creation, editing, selection, and deletion.
- **Adaptive grid and stage mode:** every video tile remains 16:9; selecting a tile promotes it to a large stage while the other participants form a row below.
- **Noise suppression:** optional RNNoise processing through the Jitsi audio-track effect API when the browser and Jitsi build support AudioWorklet.
- **Private messages:** text or attachments can be addressed to one or more selected participants through Jitsi endpoint messages.
- **Replies and meeting alerts:** click a message to reply with a quote or send only to its author; private replies keep the original recipient set, and clicking a quote jumps to and highlights its source. Collapsed-chat messages glow and play an alert, while participant joins and departures have separate room sounds.
- **Personal volume:** each remote participant can be adjusted locally from 0% to 200%; the setting changes only what the current client hears. Local microphone audio is never attached to the client's own output.
- **Chat attachments:** drag-and-drop and file-picker delivery up to 2 MB per file; images open in an in-app preview and transparent PNGs retain their alpha channel. Attachments disappear with the conference.
- **Bilingual interface:** English is the default; Russian and English can be switched on the home page or during a meeting.

## Technical checks

Install Node.js 22 and project dependencies before repository-level checks:

```bash
npm ci
npm run typecheck
npm run lint
npm run build
```

For a disposable local Jitsi + Ninjitsi stack, Docker Desktop is supported on Windows and Docker Engine on Linux:

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

The local endpoints are `http://localhost:3000` for Ninjitsi and `http://localhost:8000` for Jitsi. The scripts download the pinned Jitsi release into `.local/`, generate secrets, and determine `JVB_ADVERTISE_IPS`; override detection with `NINJITSI_JVB_ADVERTISE_IPS=address` when necessary.

With Ninjitsi running, execute UI and API smoke checks:

```bash
npm run smoke:rooms
npm run smoke:profiles
npm run smoke:visual
```

Run the real media check against a reachable Jitsi instance:

```bash
NINJITSI_BASE_URL=http://localhost:3000 \
NINJITSI_JITSI_URL=http://localhost:8000 \
npm run smoke:jitsi
```

On PowerShell:

```powershell
$env:NINJITSI_BASE_URL = "http://localhost:3000"
$env:NINJITSI_JITSI_URL = "http://localhost:8000"
npm run smoke:jitsi
```

The Jitsi smoke check creates a server-issued room and multiple isolated browser clients. It verifies microphone and camera publication, remote audio/video reception, absence of local audio playback, screen sharing, replies and private-message isolation, automatic recipient reset, unread/chat and participant sounds, attachments and transparent image preview, a stable grid while chat animates, per-participant volume up to 200%, connection statistics, stage mode, device settings, noise-suppression support, and recovery after an initial device-access failure.

For a long-session transport check, keep the clients connected for the required duration:

```bash
NINJITSI_STABILITY_MS=21600000 \
NINJITSI_BASE_URL=https://call.example.com \
NINJITSI_JITSI_URL=https://jitsi.example.com \
npm run smoke:jitsi
```

`21600000` ms is six hours. A production acceptance test must use two physical networks and real devices; a headless browser on the Docker host cannot prove NAT, firewall, TURN, echo-cancellation, or six-hour Internet stability.
