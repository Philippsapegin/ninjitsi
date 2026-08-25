param(
  [ValidateSet("prepare", "up", "down", "status", "logs")]
  [string]$Action = "up"
)

$ErrorActionPreference = "Stop"
$JitsiVersion = "stable-11146-2"
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LocalRoot = Join-Path $ProjectRoot ".local"
$JitsiRoot = Join-Path $LocalRoot "jitsi"
$ReleaseMarker = Join-Path $JitsiRoot ".ninjitsi-release"
$ReleaseUrl = "https://github.com/jitsi/docker-jitsi-meet/archive/refs/tags/$JitsiVersion.zip"
$UserDockerBin = Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\resources\bin"

if (
  -not (Get-Command "docker" -ErrorAction SilentlyContinue) -and
  (Test-Path (Join-Path $UserDockerBin "docker.exe"))
) {
  $env:PATH = "$UserDockerBin;$env:PATH"
}

function Assert-Command {
  param([string]$Name)

  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Command '$Name' was not found. Install Docker Desktop and retry."
  }
}

function New-Secret {
  return ([guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N"))
}

function Get-JitsiEnvValue {
  param([string]$Name)

  $EnvPath = Join-Path $JitsiRoot ".env"
  $Match = Get-Content -LiteralPath $EnvPath |
    Where-Object { $_ -match "^$([regex]::Escape($Name))=" } |
    Select-Object -Last 1

  if (-not $Match) {
    throw "Jitsi setting '$Name' is missing from $EnvPath."
  }

  return ($Match -split "=", 2)[1]
}

function Get-JvbAdvertiseIps {
  if ($env:NINJITSI_JVB_ADVERTISE_IPS) {
    return $env:NINJITSI_JVB_ADVERTISE_IPS.Trim()
  }

  $Addresses = Get-NetIPInterface `
      -AddressFamily IPv4 `
      -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ConnectionState -eq "Connected" -and
      $_.InterfaceAlias -notmatch "(?i)docker|hyper-v|loopback|vethernet|wsl"
    } |
    Sort-Object InterfaceMetric |
    ForEach-Object {
      Get-NetIPAddress `
        -InterfaceIndex $_.InterfaceIndex `
        -AddressFamily IPv4 `
        -ErrorAction SilentlyContinue
    } |
    Where-Object {
      $_.AddressState -eq "Preferred" -and
      $_.IPAddress -notlike "127.*" -and
      $_.IPAddress -notlike "169.254.*"
    } |
    Select-Object -ExpandProperty IPAddress -Unique

  if (-not $Addresses) {
    Write-Warning "No active physical IPv4 address was found. Set NINJITSI_JVB_ADVERTISE_IPS manually."
    return "127.0.0.1"
  }

  return ($Addresses -join ",")
}

function Test-DockerReady {
  $PreviousErrorPreference = $ErrorActionPreference

  try {
    $ErrorActionPreference = "SilentlyContinue"
    docker info *> $null
    return $LASTEXITCODE -eq 0
  } finally {
    $ErrorActionPreference = $PreviousErrorPreference
  }
}

function Initialize-Docker {
  if (Test-DockerReady) {
    return
  }

  $DesktopCandidates = @(
    (Join-Path $env:LOCALAPPDATA "Programs\DockerDesktop\Docker Desktop.exe"),
    "C:\Program Files\Docker\Docker\Docker Desktop.exe"
  )
  $Desktop = $DesktopCandidates |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1

  if (-not $Desktop) {
    throw "Docker daemon is not running and Docker Desktop was not found."
  }

  Write-Host "Starting Docker Desktop..."
  Start-Process -FilePath $Desktop -WindowStyle Hidden

  for ($Attempt = 0; $Attempt -lt 30; $Attempt += 1) {
    Start-Sleep -Seconds 2

    if (Test-DockerReady) {
      return
    }
  }

  throw "Docker Desktop did not become ready within 60 seconds."
}

function Initialize-Jitsi {
  New-Item -ItemType Directory -Force -Path $LocalRoot | Out-Null
  $JvbAdvertiseIps = Get-JvbAdvertiseIps

  $PreparedVersion = if (Test-Path $ReleaseMarker) {
    (Get-Content -Raw $ReleaseMarker).Trim()
  } else {
    ""
  }

  if ($PreparedVersion -ne $JitsiVersion) {
    if (Test-Path $JitsiRoot) {
      if ($Action -ne "up") {
        throw "Jitsi $PreparedVersion is prepared; run stack:up to migrate to $JitsiVersion."
      }

      Write-Host "Stopping the previous Jitsi release before migration..."
      Push-Location $JitsiRoot
      try {
        docker compose down

        if ($LASTEXITCODE -ne 0) {
          throw "The previous Jitsi stack could not be stopped safely."
        }
      } finally {
        Pop-Location
      }

      $BackupName = "jitsi-backup-{0}" -f (Get-Date -Format "yyyyMMdd-HHmmss")
      Move-Item -LiteralPath $JitsiRoot -Destination (Join-Path $LocalRoot $BackupName)
    }

    $TempRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ninjitsi-" + [guid]::NewGuid().ToString("N"))
    $ArchivePath = Join-Path $TempRoot "jitsi.zip"
    $ExtractRoot = Join-Path $TempRoot "extract"

    New-Item -ItemType Directory -Force -Path $ExtractRoot | Out-Null

    try {
      Write-Host "Downloading official docker-jitsi-meet $JitsiVersion..."
      Invoke-WebRequest -UseBasicParsing -Uri $ReleaseUrl -OutFile $ArchivePath
      Expand-Archive -LiteralPath $ArchivePath -DestinationPath $ExtractRoot
      $Extracted = Get-ChildItem -LiteralPath $ExtractRoot -Directory | Select-Object -First 1

      if (-not $Extracted) {
        throw "The Jitsi archive does not contain the expected directory."
      }

      Move-Item -LiteralPath $Extracted.FullName -Destination $JitsiRoot
      Set-Content -Encoding UTF8 -NoNewline -LiteralPath $ReleaseMarker -Value $JitsiVersion
    } finally {
      if (Test-Path $TempRoot) {
        Remove-Item -LiteralPath $TempRoot -Recurse -Force
      }
    }
  }

  $EnvPath = Join-Path $JitsiRoot ".env"

  if (-not (Test-Path $EnvPath)) {
    Copy-Item -LiteralPath (Join-Path $JitsiRoot "env.example") -Destination $EnvPath

    $LocalDefaults = @(
      "",
      "# Ninjitsi local defaults",
      "CONFIG=./config",
      "HTTP_PORT=8000",
      "HTTPS_PORT=8443",
      "TZ=Asia/Yekaterinburg",
      "PUBLIC_URL=https://localhost:8443",
      "JVB_ADVERTISE_IPS=$JvbAdvertiseIps",
      "DOCKER_HOST_ADDRESS=$($JvbAdvertiseIps.Split(',')[0])",
      "ENABLE_AUTH=1",
      "ENABLE_GUESTS=0",
      "AUTH_TYPE=jwt",
      "JWT_APP_ID=ninjitsi",
      "JWT_APP_SECRET=$(New-Secret)",
      "JWT_ACCEPTED_ISSUERS=ninjitsi",
      "JWT_ACCEPTED_AUDIENCES=ninjitsi",
      "JWT_ALLOW_EMPTY=0",
      "JWT_AUTH_TYPE=token",
      "JWT_TOKEN_AUTH_MODULE=token_verification",
      "ENABLE_LETSENCRYPT=0",
      "ENABLE_HTTP_REDIRECT=0",
      "ENABLE_PREJOIN_PAGE=0",
      "ENABLE_WELCOME_PAGE=0",
      "JICOFO_AUTH_PASSWORD=$(New-Secret)",
      "JVB_AUTH_PASSWORD=$(New-Secret)",
      "JIGASI_XMPP_PASSWORD=$(New-Secret)",
      "JIBRI_RECORDER_PASSWORD=$(New-Secret)",
      "JIBRI_XMPP_PASSWORD=$(New-Secret)"
    )

    $LocalDefaults | Add-Content -Encoding UTF8 -LiteralPath $EnvPath
  }

  $EnvContent = Get-Content -Raw -LiteralPath $EnvPath
  $UpdatedEnvContent = $EnvContent.Replace(
    "PUBLIC_URL=http://localhost:8000",
    "PUBLIC_URL=https://localhost:8443"
  )
  $UpdatedEnvContent = [regex]::Replace(
    $UpdatedEnvContent,
    "(?m)^JVB_ADVERTISE_IPS=.*$",
    "JVB_ADVERTISE_IPS=$JvbAdvertiseIps"
  )
  $UpdatedEnvContent = [regex]::Replace(
    $UpdatedEnvContent,
    "(?m)^DOCKER_HOST_ADDRESS=.*$",
    "DOCKER_HOST_ADDRESS=$($JvbAdvertiseIps.Split(',')[0])"
  )

  if ($UpdatedEnvContent -ne $EnvContent) {
    Set-Content -Encoding UTF8 -NoNewline -LiteralPath $EnvPath -Value $UpdatedEnvContent
  }

  $ConfigDirectories = @(
    "web",
    "prosody/config",
    "prosody/prosody-plugins-custom",
    "jicofo",
    "jvb",
    "jigasi",
    "jibri",
    "transcriber",
    "storage/jibri",
    "storage/prosody",
    "storage/transcripts",
    "storage/web",
    "tmp/web-crontabs",
    "tmp/web-load-test"
  )
  $ConfigDirectories | ForEach-Object {
    New-Item -ItemType Directory -Force -Path (Join-Path $JitsiRoot "config/$_") | Out-Null
  }

  Write-Host "Jitsi is prepared in $JitsiRoot (media address: $JvbAdvertiseIps)"
}

function Set-LocalJitsiBrowserConfig {
  $ConfigPath = Join-Path $JitsiRoot "config\web\custom-config.js"
  $Config = @(
    "config.bosh = 'http://localhost:8000/http-bind';",
    "config.websocket = 'ws://localhost:8000/xmpp-websocket';"
  ) -join [Environment]::NewLine

  Set-Content -Encoding ASCII -NoNewline -LiteralPath $ConfigPath -Value $Config
  Write-Host "Jitsi browser signaling uses local HTTP endpoints."
}

if ($Action -eq "prepare") {
  Initialize-Jitsi
  exit 0
}

Assert-Command "docker"
Initialize-Docker

if ($Action -eq "up") {
  Initialize-Jitsi
} elseif (-not (Test-Path (Join-Path $JitsiRoot ".env"))) {
  throw "Jitsi is not prepared. Run stack:up first."
}

$env:JITSI_AUTH_MODE = "token"
$env:JITSI_JWT_APP_ID = Get-JitsiEnvValue "JWT_APP_ID"
$env:JITSI_JWT_AUDIENCE = $env:JITSI_JWT_APP_ID
$env:JITSI_JWT_SUBJECT = "meet.jitsi"
$env:JITSI_JWT_SECRET = Get-JitsiEnvValue "JWT_APP_SECRET"

if ($Action -eq "up") {
  Set-LocalJitsiBrowserConfig
}

Push-Location $JitsiRoot
try {
  if ($Action -eq "up") {
    docker compose up -d
  } elseif ($Action -eq "down") {
    docker compose down
  } elseif ($Action -eq "status") {
    docker compose ps
  } elseif ($Action -eq "logs") {
    docker compose logs --tail 100
  }

  if ($LASTEXITCODE -ne 0) {
    throw "The Jitsi Docker Compose action '$Action' failed."
  }
} finally {
  Pop-Location
}

Push-Location $ProjectRoot
try {
  if ($Action -eq "up") {
    docker compose up -d --build
  } elseif ($Action -eq "down") {
    docker compose down
  } elseif ($Action -eq "status") {
    docker compose ps
  } elseif ($Action -eq "logs") {
    docker compose logs --tail 100
  }

  if ($LASTEXITCODE -ne 0) {
    throw "The Ninjitsi Docker Compose action '$Action' failed."
  }
} finally {
  Pop-Location
}

if ($Action -eq "up") {
  Write-Host ""
  Write-Host "Ninjitsi: http://localhost:3000"
  Write-Host "Jitsi:    http://localhost:8000"
}
